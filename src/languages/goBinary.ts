/**
 * Prebuilt-binary architecture inspection for the Go analyzer subprocess.
 *
 * The Go analyzer ships as a single prebuilt binary (currently darwin/amd64).
 * On any other platform/architecture it cannot run, so the runtime must detect
 * the mismatch and rebuild from the shipped source instead of spawning a binary
 * that will fail to exec (or silently no-op). This module is the pure,
 * header-only check shared by path resolution (detection) and the build step,
 * so a stale or wrong-arch binary is caught on every path that reaches for it —
 * not only the one that happens to rebuild.
 *
 * No filesystem access here: callers read the first bytes of the binary and
 * pass the buffer in, which keeps this deterministic and unit-testable.
 */

export type ExecutableFormat = 'macho' | 'elf' | 'pe' | 'fat-macho' | 'unknown';
export type ExecutableArch = 'x64' | 'arm64' | 'ia32' | 'arm' | 'unknown';

export interface ExecutableIdentity {
  format: ExecutableFormat;
  arch: ExecutableArch;
}

export interface BinaryMatch {
  /** True when the binary runs natively on the given platform/arch. */
  matches: boolean;
  /**
   * Why the binary does not match. `absent` means no header was supplied
   * (the file is missing or could not be read); the caller distinguishes the
   * two because it already performs its own existence check.
   */
  reason: 'ok' | 'absent' | 'format-mismatch' | 'arch-mismatch' | 'unknown-format';
  /** Parsed identity when a header was available, else null. */
  identity: ExecutableIdentity | null;
}

// Mach-O 64-bit little-endian magic and cputype (thin header, offset 4).
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC_BE = 0xcafebabe; // read little-endian from a big-endian blob
const FAT_MAGIC_LE = 0xbebafeca; // the reverse, also accepted defensively

const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

// ELF e_machine constants (offset 18).
const EM_386 = 3;
const EM_ARM = 40;
const EM_X86_64 = 62;
const EM_AARCH64 = 183;

// PE machine constants (e_lfanew + 4).
const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_MACHINE_ARM = 0x01c0;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

/**
 * Inspect a binary's header and report its format and architecture.
 * `header` must be the first bytes of the file (>= 4; up to ~128 is plenty —
 * PE needs 0x3c + 6).
 */
export function inspectExecutable(header: Buffer): ExecutableIdentity {
  if (header.length < 4) return { format: 'unknown', arch: 'unknown' };

  const b0 = header[0];
  const b1 = header[1];
  const b2 = header[2];
  const b3 = header[3];
  const leMagic = header.readUInt32LE(0);

  // Mach-O (thin, little-endian). 64-bit and 32-bit share the cputype offset.
  if (leMagic === MH_MAGIC_64 || leMagic === MH_MAGIC) {
    const cputype = header.readUInt32LE(4);
    return { format: 'macho', arch: machoCpuToArch(cputype) };
  }

  // Fat/universal Mach-O. We do not enumerate slices; a universal binary is
  // never shipped, and treating it as unresolved forces the safe rebuild.
  if (leMagic === FAT_MAGIC_BE || leMagic === FAT_MAGIC_LE) {
    return { format: 'fat-macho', arch: 'unknown' };
  }

  // ELF
  if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) {
    if (header.length < 20) return { format: 'elf', arch: 'unknown' };
    const bigEndian = header[5] === 2;
    const machine = bigEndian ? header.readUInt16BE(18) : header.readUInt16LE(18);
    return { format: 'elf', arch: elfMachineToArch(machine) };
  }

  // PE ("MZ")
  if (b0 === 0x4d && b1 === 0x5a) {
    if (header.length < 0x3c + 6) return { format: 'pe', arch: 'unknown' };
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 > header.length) return { format: 'pe', arch: 'unknown' };
    const machine = header.readUInt16LE(peOffset + 4);
    return { format: 'pe', arch: peMachineToArch(machine) };
  }

  return { format: 'unknown', arch: 'unknown' };
}

/**
 * Decide whether an existing binary is runnable on the given platform/arch.
 * Pass `null` for the header when the file is absent or unreadable.
 */
export function binaryMatchesPlatform(
  header: Buffer | null,
  platform: string = process.platform,
  arch: string = process.arch,
): BinaryMatch {
  if (header === null) {
    return { matches: false, reason: 'absent', identity: null };
  }

  const identity = inspectExecutable(header);
  const expectedFormat = platformToFormat(platform);
  if (expectedFormat === null || identity.format === 'unknown' || identity.format === 'fat-macho') {
    // An unsupported platform or an unparsed header can't be confirmed native,
    // so the only safe answer is "rebuild".
    return { matches: false, reason: 'unknown-format', identity };
  }
  if (identity.format !== expectedFormat) {
    return { matches: false, reason: 'format-mismatch', identity };
  }

  const expectedArch = nodeArchToExecutableArch(arch);
  if (identity.arch === 'unknown') {
    return { matches: false, reason: 'unknown-format', identity };
  }
  if (identity.arch !== expectedArch) {
    return { matches: false, reason: 'arch-mismatch', identity };
  }

  return { matches: true, reason: 'ok', identity };
}

/** Human-readable reason a mismatched binary can't run, for diagnostics. */
export function describeBinaryMismatch(match: BinaryMatch, platform: string, arch: string): string {
  if (match.identity) {
    const target = match.identity.arch !== 'unknown'
      ? `${match.identity.format}/${match.identity.arch}`
      : match.identity.format;
    if (match.reason === 'arch-mismatch') {
      return `shipped analyzer targets ${target}, but this machine is ${platform}/${arch}`;
    }
    if (match.reason === 'format-mismatch') {
      return `shipped analyzer is ${target} (not runnable on ${platform}/${arch})`;
    }
    if (match.reason === 'unknown-format') {
      return `shipped analyzer has an unrecognized executable format`;
    }
  }
  if (match.reason === 'absent') return 'analyzer binary is absent';
  return 'analyzer binary is not runnable here';
}

// --- Mappers -----------------------------------------------------------------

function platformToFormat(platform: string): ExecutableFormat | null {
  switch (platform) {
    case 'darwin': return 'macho';
    case 'linux': return 'elf';
    case 'win32': return 'pe';
    default: return null;
  }
}

function nodeArchToExecutableArch(arch: string): ExecutableArch {
  switch (arch) {
    case 'x64': return 'x64';
    case 'arm64': return 'arm64';
    case 'ia32': return 'ia32';
    case 'arm': return 'arm';
    default: return 'unknown';
  }
}

function machoCpuToArch(cputype: number): ExecutableArch {
  switch (cputype) {
    case CPU_TYPE_X86_64: return 'x64';
    case CPU_TYPE_ARM64: return 'arm64';
    case CPU_TYPE_X86: return 'ia32';
    case CPU_TYPE_ARM: return 'arm';
    default: return 'unknown';
  }
}

function elfMachineToArch(machine: number): ExecutableArch {
  switch (machine) {
    case EM_X86_64: return 'x64';
    case EM_AARCH64: return 'arm64';
    case EM_386: return 'ia32';
    case EM_ARM: return 'arm';
    default: return 'unknown';
  }
}

function peMachineToArch(machine: number): ExecutableArch {
  switch (machine) {
    case IMAGE_FILE_MACHINE_AMD64: return 'x64';
    case IMAGE_FILE_MACHINE_ARM64: return 'arm64';
    case IMAGE_FILE_MACHINE_I386: return 'ia32';
    case IMAGE_FILE_MACHINE_ARM: return 'arm';
    default: return 'unknown';
  }
}
