#!/usr/bin/env node

import { WhitelistService } from './dist/services/whitelistService.js';
import { WhitelistType, WhitelistStatus } from './dist/types/whitelist.js';

async function testWhitelist() {
  console.log('Testing whitelist functionality...\n');
  
  const service = WhitelistService.getInstance();
  
  // Test 1: Get all entries
  console.log('1. Getting all whitelist entries:');
  const allEntries = await service.getWhitelist();
  console.log(`   Total entries: ${allEntries.length}`);
  
  // Test 2: Add platform API entries
  console.log('\n2. Adding platform API entries:');
  try {
    await service.addEntry('URL', WhitelistType.PlatformAPI, 'Web API for URL manipulation');
    await service.addEntry('URLSearchParams', WhitelistType.PlatformAPI, 'Web API for URL query parameters');
    await service.addEntry('FormData', WhitelistType.PlatformAPI, 'Web API for form data');
    console.log('   ✓ Added platform API entries');
  } catch (error) {
    console.log('   Entries might already exist:', error.message);
  }
  
  // Test 3: Add Node.js built-ins
  console.log('\n3. Adding Node.js built-in modules:');
  const nodeBuiltins = ['fs', 'path', 'crypto', 'http', 'https', 'stream', 'buffer', 'os', 'process'];
  for (const builtin of nodeBuiltins) {
    try {
      await service.addEntry(builtin, WhitelistType.NodeBuiltin, `Node.js ${builtin} module`);
    } catch (error) {
      // Ignore duplicates
    }
  }
  console.log('   ✓ Added Node.js built-ins');
  
  // Test 4: Detect from package.json
  console.log('\n4. Detecting dependencies from package.json:');
  const suggestions = await service.detectFromPackageJson('.');
  console.log(`   Found ${suggestions.length} dependency suggestions`);
  console.log('   Top 5 suggestions:');
  suggestions.slice(0, 5).forEach(s => {
    console.log(`   - ${s.name} (${s.type}): ${s.reason}`);
  });
  
  // Test 5: Auto-populate high confidence entries
  console.log('\n5. Auto-populating high confidence entries:');
  const result = await service.autoPopulateWhitelist('.');
  console.log(`   ✓ Added ${result.added} entries automatically`);
  console.log(`   ${result.suggestions.length} suggestions need manual review`);
  
  // Test 6: Check if specific entries are whitelisted
  console.log('\n6. Testing whitelist checks:');
  const testCases = [
    { name: 'URL', type: WhitelistType.PlatformAPI },
    { name: 'fs', type: WhitelistType.NodeBuiltin },
    { name: 'lodash', type: WhitelistType.SharedLibrary },
    { name: 'MyCustomClass', type: WhitelistType.PlatformAPI }
  ];
  
  for (const test of testCases) {
    const isWhitelisted = await service.isWhitelisted(test.name, test.type);
    console.log(`   ${test.name} (${test.type}): ${isWhitelisted ? '✓ whitelisted' : '✗ not whitelisted'}`);
  }
  
  // Test 7: Get entries by type
  console.log('\n7. Getting entries by type:');
  const types = [WhitelistType.PlatformAPI, WhitelistType.NodeBuiltin, WhitelistType.ProjectDependency];
  for (const type of types) {
    const entries = await service.getWhitelist(type);
    console.log(`   ${type}: ${entries.length} entries`);
  }
  
  console.log('\n✓ Whitelist tests completed!');
}

testWhitelist().catch(console.error);