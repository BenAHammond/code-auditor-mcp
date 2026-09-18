import { describe, it, expect } from 'vitest';
import {
  inspectExecutable,
  binaryMatchesPlatform,
  describeBinaryMismatch,
} from './goBinary.js';

// --- Header builders (synthetic, minimal) ------------------------------------

function machoHeader(cputype: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64 (little-endian)
  b.writeUInt32LE(cputype, 4);
  return b;
}

function elfHeader(machine: number): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46; // \x7fELF
  b[4] = 2; // 64-bit
  b[5] = 1; // little-endian
  b.writeUInt16LE(machine, 18);
  return b;
}

function peHeader(machine: number): Buffer {
  const b = Buffer.alloc(0x80);
  b[0] = 0x4d; b[1] = 0x5a; // "MZ"
  b.writeUInt32LE(0x40, 0x3c); // e_lfanew -> PE header
  b.write('PE\0\0', 0x40, 'ascii');
  b.writeUInt16LE(machine, 0x44);
  return b;
}

const X86_64 = 0x01000007;
const ARM64 = 0x0100000c;

describe('inspectExecutable', () => {
  it('reads a thin 64-bit Mach-O x86_64 header', () => {
    expect(inspectExecutable(machoHeader(X86_64))).toEqual({ format: 'macho', arch: 'x64' });
  });

  it('reads a thin 64-bit Mach-O arm64 header', () => {
    expect(inspectExecutable(machoHeader(ARM64))).toEqual({ format: 'macho', arch: 'arm64' });
  });

  it('reads an ELF x86_64 header', () => {
    expect(inspectExecutable(elfHeader(62))).toEqual({ format: 'elf', arch: 'x64' });
  });

  it('reads an ELF aarch64 header', () => {
    expect(inspectExecutable(elfHeader(183))).toEqual({ format: 'elf', arch: 'arm64' });
  });

  it('reads a PE x64 header', () => {
    expect(inspectExecutable(peHeader(0x8664))).toEqual({ format: 'pe', arch: 'x64' });
  });

  it('reports unknown for a non-executable blob', () => {
    expect(inspectExecutable(Buffer.from('hello world'))).toEqual({ format: 'unknown', arch: 'unknown' });
  });
});

describe('binaryMatchesPlatform', () => {
  it('accepts a Mach-O x86_64 binary on darwin/x64', () => {
    expect(binaryMatchesPlatform(machoHeader(X86_64), 'darwin', 'x64').matches).toBe(true);
  });

  it('rejects the committed amd64 binary on darwin/arm64 (arch mismatch)', () => {
    const m = binaryMatchesPlatform(machoHeader(X86_64), 'darwin', 'arm64');
    expect(m.matches).toBe(false);
    expect(m.reason).toBe('arch-mismatch');
    expect(describeBinaryMismatch(m, 'darwin', 'arm64')).toContain('darwin/arm64');
  });

  it('accepts a Mach-O arm64 binary on darwin/arm64', () => {
    expect(binaryMatchesPlatform(machoHeader(ARM64), 'darwin', 'arm64').matches).toBe(true);
  });

  it('rejects a Mach-O binary on linux (format mismatch)', () => {
    const m = binaryMatchesPlatform(machoHeader(X86_64), 'linux', 'x64');
    expect(m.matches).toBe(false);
    expect(m.reason).toBe('format-mismatch');
  });

  it('rejects a Mach-O binary on win32 (format mismatch)', () => {
    expect(binaryMatchesPlatform(machoHeader(X86_64), 'win32', 'x64').matches).toBe(false);
  });

  it('accepts an ELF x86_64 binary on linux/x64', () => {
    expect(binaryMatchesPlatform(elfHeader(62), 'linux', 'x64').matches).toBe(true);
  });

  it('accepts a PE x64 binary on win32/x64', () => {
    expect(binaryMatchesPlatform(peHeader(0x8664), 'win32', 'x64').matches).toBe(true);
  });

  it('reports absent for a null header', () => {
    const m = binaryMatchesPlatform(null, 'darwin', 'arm64');
    expect(m.matches).toBe(false);
    expect(m.reason).toBe('absent');
  });

  it('treats an unsupported platform as needing a rebuild', () => {
    expect(binaryMatchesPlatform(machoHeader(X86_64), 'freebsd', 'x64').matches).toBe(false);
  });
});
