import React, { forwardRef, memo, useImperativeHandle, useRef, useState, useEffect } from 'react';

// Edge Case 5: Memoized and ForwardRef components
// Should properly detect these wrapped components

// ForwardRef component with mixed responsibilities
export const DataGridWithRef = forwardRef<
  { refresh: () => void; exportData: () => void },
  { apiUrl: string; columns: string[] }
>(({ apiUrl, columns }, ref) => {
  // State management
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortConfig, setSortConfig] = useState({ column: '', direction: 'asc' });
  const [filters, setFilters] = useState<Record<string, string>>({});
  
  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const downloadLinkRef = useRef<HTMLAnchorElement>(null);
  
  // Data fetching
  const fetchData = async () => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams({
        ...filters,
        sort: sortConfig.column,
        direction: sortConfig.direction
      });
      
      const response = await fetch(`${apiUrl}?${queryParams}`);
      const result = await response.json();
      setData(result);
      
      // Analytics tracking
      window.analytics?.track('data_grid_loaded', {
        rowCount: result.length,
        filters: Object.keys(filters).length
      });
    } catch (error) {
      console.error('Failed to fetch data', error);
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    fetchData();
  }, [apiUrl, sortConfig, filters]);
  
  // Export functionality
  const exportData = () => {
    const csv = convertToCSV(data, columns);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    
    if (downloadLinkRef.current) {
      downloadLinkRef.current.href = url;
      downloadLinkRef.current.download = 'export.csv';
      downloadLinkRef.current.click();
    }
    
    // Track export
    window.analytics?.track('data_exported', {
      format: 'csv',
      rowCount: data.length
    });
  };
  
  // Imperative handle
  useImperativeHandle(ref, () => ({
    refresh: fetchData,
    exportData
  }), [data]);
  
  // Business logic
  const convertToCSV = (data: any[], columns: string[]) => {
    const header = columns.join(',');
    const rows = data.map(row => 
      columns.map(col => row[col]).join(',')
    );
    return [header, ...rows].join('\n');
  };
  
  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        exportData();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [data]);
  
  return (
    <div ref={containerRef} className="data-grid">
      <div className="grid-toolbar">
        {columns.map(col => (
          <input
            key={col}
            placeholder={`Filter ${col}...`}
            onChange={(e) => setFilters(prev => ({
              ...prev,
              [col]: e.target.value
            }))}
          />
        ))}
      </div>
      
      {loading ? (
        <div>Loading...</div>
      ) : (
        <table>
          <thead>
            <tr>
              {columns.map(col => (
                <th 
                  key={col}
                  onClick={() => setSortConfig({
                    column: col,
                    direction: sortConfig.column === col && sortConfig.direction === 'asc' ? 'desc' : 'asc'
                  })}
                >
                  {col} {sortConfig.column === col && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, idx) => (
              <tr key={idx}>
                {columns.map(col => (
                  <td key={col}>{row[col]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      
      <a ref={downloadLinkRef} style={{ display: 'none' }} />
    </div>
  );
});

DataGridWithRef.displayName = 'DataGridWithRef';

// Memoized component with performance optimization and mixed concerns
export const ExpensiveChart = memo(({ data, type }: { data: any[]; type: 'bar' | 'line' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tooltip, setTooltip] = useState({ show: false, x: 0, y: 0, text: '' });
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  
  // Chart rendering (expensive operation)
  useEffect(() => {
    if (!canvasRef.current || !data.length) return;
    
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    
    // Complex chart rendering logic
    if (type === 'bar') {
      renderBarChart(ctx, data);
    } else {
      renderLineChart(ctx, data);
    }
    
    // Log performance metrics
    console.log('Chart rendered', { dataPoints: data.length, type });
  }, [data, type]);
  
  // Mouse interaction handlers
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Calculate which data point is hovered
    const pointIndex = Math.floor((x / rect.width) * data.length);
    
    if (pointIndex >= 0 && pointIndex < data.length) {
      setTooltip({
        show: true,
        x: e.clientX,
        y: e.clientY,
        text: `Value: ${data[pointIndex].value}`
      });
      
      // Track hover analytics
      window.analytics?.track('chart_point_hovered', {
        pointIndex,
        value: data[pointIndex].value
      });
    }
  };
  
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = e.clientX - rect.left;
    const pointIndex = Math.floor((x / rect.width) * data.length);
    
    setSelectedPoint(pointIndex);
    
    // External API call on selection
    fetch('/api/chart-selection', {
      method: 'POST',
      body: JSON.stringify({
        chartType: type,
        selectedIndex: pointIndex,
        value: data[pointIndex]
      })
    });
  };
  
  // Helper functions (should be outside component)
  const renderBarChart = (ctx: CanvasRenderingContext2D, data: any[]) => {
    // Complex rendering logic
  };
  
  const renderLineChart = (ctx: CanvasRenderingContext2D, data: any[]) => {
    // Complex rendering logic
  };
  
  return (
    <div className="chart-container">
      <canvas
        ref={canvasRef}
        width={800}
        height={400}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip({ ...tooltip, show: false })}
        onClick={handleClick}
      />
      
      {tooltip.show && (
        <div 
          className="chart-tooltip" 
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}
      
      {selectedPoint !== null && (
        <div className="selection-info">
          Selected: Point {selectedPoint} - Value: {data[selectedPoint]?.value}
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function
  return prevProps.data.length === nextProps.data.length &&
         prevProps.type === nextProps.type &&
         JSON.stringify(prevProps.data) === JSON.stringify(nextProps.data);
});

ExpensiveChart.displayName = 'ExpensiveChart';

// Double wrapped component
export const EnhancedInput = memo(forwardRef<
  HTMLInputElement,
  { label: string; validator?: (value: string) => string | null }
>(({ label, validator }, ref) => {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  
  // Validation
  useEffect(() => {
    if (validator && value) {
      const validationError = validator(value);
      setError(validationError);
    }
  }, [value, validator]);
  
  // Analytics for input interactions
  useEffect(() => {
    if (isFocused) {
      window.analytics?.track('input_focused', { label });
    }
  }, [isFocused, label]);
  
  // Debounced API call for autocomplete
  useEffect(() => {
    if (!value || error) return;
    
    const timer = setTimeout(() => {
      fetch(`/api/autocomplete?q=${value}`)
        .then(res => res.json())
        .then(suggestions => {
          console.log('Autocomplete suggestions:', suggestions);
        });
    }, 300);
    
    return () => clearTimeout(timer);
  }, [value, error]);
  
  return (
    <div className="enhanced-input">
      <label>{label}</label>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        className={error ? 'error' : ''}
      />
      {error && <span className="error-message">{error}</span>}
    </div>
  );
}));

EnhancedInput.displayName = 'EnhancedInput';