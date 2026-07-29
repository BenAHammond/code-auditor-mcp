// Shadcn-style components with semantic theme classes and utilities
export function Button() {
  return (
    <button className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium inline-flex items-center justify-center hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
      Click me
    </button>
  );
}

export function Card() {
  return (
    <div className="bg-card text-card-foreground rounded-xl shadow-sm border-border">
      <div className="bg-muted text-muted-foreground p-4">
        <h2 className="text-foreground">Title</h2>
      </div>
    </div>
  );
}

export function DestructiveAction() {
  return (
    <button className="bg-destructive flex gap-2 hover:bg-blue-600/75 bg-red-500/50 disabled:opacity-50">
      Delete
    </button>
  );
}

export function ArbitraryValues() {
  return (
    <div className="w-[73px] mt-[2px] bg-[#123456] text-[rgb(255,255,255)] grid-cols-[repeat(3,minmax(0,1fr))]">
      Custom
    </div>
  );
}

export function DeliberateUnknown() {
  return (
    <div className="not-a-real-class-xyzzy bogus-utility-should-not-exist">
      Should trigger undefined-class
    </div>
  );
}
