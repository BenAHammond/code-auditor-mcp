import { NextResponse } from 'next/server';

export async function GET() {
  // This should NOT be flagged as a DI violation
  return new NextResponse('Hello World', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
    },
  });
}

export async function POST(request: Request) {
  // Neither should this
  return NextResponse.json({ message: 'Created' }, { status: 201 });
}