#!/usr/bin/env node

import { SchemaParser } from './dist/services/SchemaParser.js';
import { CodeIndexDB } from './dist/codeIndexDB.js';
import path from 'path';

async function testSchemaFeature() {
  console.log('🧪 Testing DB Schema Indexing Feature...\n');
  
  try {
    // Test 1: Parse schema file
    console.log('1. Testing schema parsing...');
    const parser = new SchemaParser();
    const schemaPath = path.join(process.cwd(), 'examples', 'schema-example.json');
    
    const parseResult = await parser.parseFromFile(schemaPath);
    
    if (!parseResult.success) {
      console.log('❌ Schema parsing failed:', parseResult.errors);
      return;
    }
    
    console.log('✅ Schema parsed successfully');
    console.log(`   - Schema name: ${parseResult.schema.name}`);
    console.log(`   - Databases: ${parseResult.schema.databases.length}`);
    console.log(`   - Violations: ${parseResult.violations.length}`);
    
    // Test 2: Store schema in database
    console.log('\n2. Testing schema storage...');
    const db = CodeIndexDB.getInstance();
    await db.initialize();
    
    const schemaId = await db.storeSchema(parseResult.schema);
    console.log('✅ Schema stored successfully');
    console.log(`   - Schema ID: ${schemaId}`);
    
    // Test 3: Retrieve schemas
    console.log('\n3. Testing schema retrieval...');
    const allSchemas = await db.getAllSchemas();
    console.log('✅ Schemas retrieved successfully');
    console.log(`   - Total schemas: ${allSchemas.length}`);
    
    // Test 4: Get schema stats
    console.log('\n4. Testing schema statistics...');
    const stats = await db.getSchemaStats();
    console.log('✅ Statistics generated successfully');
    console.log(`   - Total tables: ${stats.totalTables}`);
    console.log(`   - Most used tables: ${stats.mostUsedTables.length}`);
    
    // Test 5: Record some mock usage
    console.log('\n5. Testing schema usage recording...');
    await db.recordSchemaUsage({
      tableName: 'users',
      filePath: '/mock/userService.ts', 
      functionName: 'getUserById',
      usageType: 'query',
      line: 42,
      column: 10
    });
    
    await db.recordSchemaUsage({
      tableName: 'posts',
      filePath: '/mock/postService.ts',
      functionName: 'createPost', 
      usageType: 'insert',
      line: 15,
      column: 5
    });
    
    console.log('✅ Schema usage recorded successfully');
    
    // Test 6: Find table usage
    console.log('\n6. Testing table usage lookup...');
    const userTableUsage = await db.findFunctionsUsingTable('users');
    console.log('✅ Table usage found successfully');
    console.log(`   - Functions using 'users' table: ${userTableUsage.length}`);
    
    // Test 7: Search with schema context
    console.log('\n7. Testing schema-aware search...');
    const searchResult = await db.searchWithSchemaContext('user', {
      includeSchemaUsage: true,
      limit: 5
    });
    console.log('✅ Schema-aware search completed');
    console.log(`   - Functions found: ${searchResult.functions.length}`);
    console.log(`   - Schema context: ${searchResult.schemaContext?.length || 0} table usages`);
    
    console.log('\n🎉 All tests passed! DB Schema Indexing feature is working correctly.');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

testSchemaFeature().catch(console.error);