// Test file to verify code-auditor improvements

// 1. Framework imports that should NOT be flagged
import { NextResponse, NextRequest } from 'next/server';
import { Pool, Client } from 'pg';
import { MongoClient } from 'mongodb';
import { Component, Fragment } from 'react';
import { Router } from 'express';
import { StackServerApp } from '@stackframe/stack';

// 2. API Route Handler (should have relaxed thresholds)
export async function GET(request: NextRequest) {
  // Framework class instantiation - should NOT be flagged
  const response = new NextResponse('Hello World', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
    },
  });
  
  // Database connection - should NOT be flagged
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20
  });
  
  // Auth library - should NOT be flagged
  const stackApp = new StackServerApp({
    appId: process.env.STACK_APP_ID!,
  });
  
  return response;
}

// 3. React Component with grouped responsibilities
import { useState, useEffect, useContext } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export function FilterComponent() {
  // State management hooks (should count as ONE responsibility)
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('date');
  const [isOpen, setIsOpen] = useState(false);
  
  // Routing hooks (should count as ONE responsibility)
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // Effect hooks (should count as related responsibility)
  useEffect(() => {
    // Sync with URL
  }, [searchParams]);
  
  // Event handlers (related to UI state)
  const handleFilterChange = () => setFilter('new');
  const handleSortChange = () => setSort('name');
  
  return <div>Filter UI</div>;
}

// 4. Repository class (should have higher method threshold)
export class UserRepository {
  private pool: Pool;
  
  constructor() {
    // Framework class - should NOT be flagged
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  
  // Many data access methods are OK for repositories
  async findById(id: string) { return null; }
  async findByEmail(email: string) { return null; }
  async findAll() { return []; }
  async create(data: any) { return null; }
  async update(id: string, data: any) { return null; }
  async delete(id: string) { return null; }
  async findByRole(role: string) { return []; }
  async findActive() { return []; }
  async findInactive() { return []; }
  async countByRole(role: string) { return 0; }
  async exists(id: string) { return false; }
  async bulkCreate(data: any[]) { return []; }
  async bulkUpdate(updates: any[]) { return []; }
  async search(query: string) { return []; }
  async findWithPagination(page: number, limit: number) { return []; }
}

// 5. Local class that SHOULD be flagged for DI
class EmailService {
  send(to: string, subject: string) {
    console.log('Sending email');
  }
}

// This SHOULD be flagged - local class without DI
export class NotificationService {
  private emailService: EmailService;
  
  constructor() {
    this.emailService = new EmailService(); // Should be injected!
  }
}