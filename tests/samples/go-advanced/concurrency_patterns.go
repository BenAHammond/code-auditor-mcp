package testadvanced

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"
)

// Complex goroutine patterns and potential issues

// WorkerPool demonstrates proper goroutine management
type WorkerPool struct {
	workers   int
	taskQueue chan Task
	wg        sync.WaitGroup
	ctx       context.Context
	cancel    context.CancelFunc
}

type Task struct {
	ID       int
	Data     string
	Callback func(string) error
}

func NewWorkerPool(workers int) *WorkerPool {
	ctx, cancel := context.WithCancel(context.Background())
	return &WorkerPool{
		workers:   workers,
		taskQueue: make(chan Task, workers*2),
		ctx:       ctx,
		cancel:    cancel,
	}
}

func (wp *WorkerPool) Start() {
	for i := 0; i < wp.workers; i++ {
		wp.wg.Add(1)
		go wp.worker(i)
	}
}

func (wp *WorkerPool) worker(id int) {
	defer wp.wg.Done()
	
	for {
		select {
		case task := <-wp.taskQueue:
			wp.processTask(id, task)
		case <-wp.ctx.Done():
			fmt.Printf("Worker %d shutting down\n", id)
			return
		}
	}
}

func (wp *WorkerPool) processTask(workerID int, task Task) {
	start := time.Now()
	
	// Simulate work with random duration
	workDuration := time.Duration(rand.Intn(1000)) * time.Millisecond
	time.Sleep(workDuration)
	
	result := fmt.Sprintf("Worker %d processed task %d: %s", workerID, task.ID, task.Data)
	
	if task.Callback != nil {
		if err := task.Callback(result); err != nil {
			fmt.Printf("Callback error for task %d: %v\n", task.ID, err)
		}
	}
	
	fmt.Printf("Task %d completed in %v\n", task.ID, time.Since(start))
}

func (wp *WorkerPool) Submit(task Task) bool {
	select {
	case wp.taskQueue <- task:
		return true
	case <-wp.ctx.Done():
		return false
	default:
		// Queue is full
		return false
	}
}

func (wp *WorkerPool) Stop() {
	wp.cancel()
	close(wp.taskQueue)
	wp.wg.Wait()
}

// ProducerConsumer demonstrates channel communication patterns
type ProducerConsumer struct {
	dataChannel   chan string
	resultChannel chan Result
	errorChannel  chan error
	workers       int
	wg            sync.WaitGroup
	once          sync.Once
}

type Result struct {
	Data      string
	ProcessedAt time.Time
	WorkerID   int
}

func NewProducerConsumer(bufferSize, workers int) *ProducerConsumer {
	return &ProducerConsumer{
		dataChannel:   make(chan string, bufferSize),
		resultChannel: make(chan Result, bufferSize),
		errorChannel:  make(chan error, bufferSize),
		workers:       workers,
	}
}

func (pc *ProducerConsumer) StartConsumers() {
	for i := 0; i < pc.workers; i++ {
		pc.wg.Add(1)
		go pc.consumer(i)
	}
}

func (pc *ProducerConsumer) consumer(workerID int) {
	defer pc.wg.Done()
	
	for data := range pc.dataChannel {
		// Simulate processing time
		processingTime := time.Duration(rand.Intn(500)) * time.Millisecond
		time.Sleep(processingTime)
		
		// Random chance of error
		if rand.Float32() < 0.1 {
			pc.errorChannel <- fmt.Errorf("worker %d failed to process: %s", workerID, data)
			continue
		}
		
		result := Result{
			Data:        fmt.Sprintf("Processed: %s", data),
			ProcessedAt: time.Now(),
			WorkerID:    workerID,
		}
		
		pc.resultChannel <- result
	}
}

func (pc *ProducerConsumer) Produce(data string) {
	pc.dataChannel <- data
}

func (pc *ProducerConsumer) Stop() {
	pc.once.Do(func() {
		close(pc.dataChannel)
		pc.wg.Wait()
		close(pc.resultChannel)
		close(pc.errorChannel)
	})
}

func (pc *ProducerConsumer) GetResult() <-chan Result {
	return pc.resultChannel
}

func (pc *ProducerConsumer) GetErrors() <-chan error {
	return pc.errorChannel
}

// RateLimiter demonstrates advanced concurrency control
type RateLimiter struct {
	tokens   chan struct{}
	refill   *time.Ticker
	capacity int
	rate     time.Duration
	mu       sync.Mutex
	closed   bool
}

func NewRateLimiter(capacity int, refillRate time.Duration) *RateLimiter {
	rl := &RateLimiter{
		tokens:   make(chan struct{}, capacity),
		capacity: capacity,
		rate:     refillRate,
	}
	
	// Fill initial tokens
	for i := 0; i < capacity; i++ {
		rl.tokens <- struct{}{}
	}
	
	// Start refill goroutine
	rl.refill = time.NewTicker(refillRate)
	go rl.refillTokens()
	
	return rl
}

func (rl *RateLimiter) refillTokens() {
	for range rl.refill.C {
		rl.mu.Lock()
		if rl.closed {
			rl.mu.Unlock()
			return
		}
		rl.mu.Unlock()
		
		select {
		case rl.tokens <- struct{}{}:
			// Token added
		default:
			// Bucket full, skip
		}
	}
}

func (rl *RateLimiter) Allow() bool {
	select {
	case <-rl.tokens:
		return true
	default:
		return false
	}
}

func (rl *RateLimiter) Wait(ctx context.Context) error {
	select {
	case <-rl.tokens:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (rl *RateLimiter) Close() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	
	if !rl.closed {
		rl.closed = true
		rl.refill.Stop()
		close(rl.tokens)
	}
}

// PipelineProcessor demonstrates complex pipeline patterns
type PipelineProcessor struct {
	stages []PipelineStage
	input  chan interface{}
	output chan interface{}
	errors chan error
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

type PipelineStage func(input interface{}) (interface{}, error)

func NewPipelineProcessor(bufferSize int, stages ...PipelineStage) *PipelineProcessor {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &PipelineProcessor{
		stages: stages,
		input:  make(chan interface{}, bufferSize),
		output: make(chan interface{}, bufferSize),
		errors: make(chan error, bufferSize),
		ctx:    ctx,
		cancel: cancel,
	}
}

func (pp *PipelineProcessor) Start() {
	channels := make([]chan interface{}, len(pp.stages)+1)
	channels[0] = pp.input
	channels[len(pp.stages)] = pp.output
	
	// Create intermediate channels
	for i := 1; i < len(pp.stages); i++ {
		channels[i] = make(chan interface{}, cap(pp.input))
	}
	
	// Start stage workers
	for i, stage := range pp.stages {
		pp.wg.Add(1)
		go pp.runStage(i, stage, channels[i], channels[i+1])
	}
}

func (pp *PipelineProcessor) runStage(stageID int, stage PipelineStage, input, output chan interface{}) {
	defer pp.wg.Done()
	defer close(output)
	
	for {
		select {
		case data, ok := <-input:
			if !ok {
				return
			}
			
			result, err := stage(data)
			if err != nil {
				select {
				case pp.errors <- fmt.Errorf("stage %d error: %w", stageID, err):
				case <-pp.ctx.Done():
					return
				}
				continue
			}
			
			select {
			case output <- result:
			case <-pp.ctx.Done():
				return
			}
			
		case <-pp.ctx.Done():
			return
		}
	}
}

func (pp *PipelineProcessor) Process(data interface{}) {
	select {
	case pp.input <- data:
	case <-pp.ctx.Done():
	}
}

func (pp *PipelineProcessor) Stop() {
	pp.cancel()
	close(pp.input)
	pp.wg.Wait()
	close(pp.errors)
}

func (pp *PipelineProcessor) GetOutput() <-chan interface{} {
	return pp.output
}

func (pp *PipelineProcessor) GetErrors() <-chan error {
	return pp.errors
}

// Problematic patterns that should be detected

// LeakyGoroutinePattern demonstrates goroutines that never terminate
func LeakyGoroutinePattern() {
	dataChan := make(chan string)
	
	// This goroutine will leak because dataChan is never closed or written to
	go func() {
		for data := range dataChan {
			fmt.Printf("Processing: %s\n", data)
		}
	}()
	
	// Function returns without managing the goroutine
	fmt.Println("Function completed, but goroutine is still running")
}

// RaceConditionPattern demonstrates potential race conditions
var globalCounter int

func RaceConditionPattern() {
	var wg sync.WaitGroup
	
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Race condition: multiple goroutines accessing globalCounter
			globalCounter++
			fmt.Printf("Counter: %d\n", globalCounter)
		}()
	}
	
	wg.Wait()
}

// DeadlockPattern demonstrates potential deadlock
func DeadlockPattern() {
	ch1 := make(chan string)
	ch2 := make(chan string)
	
	go func() {
		ch1 <- "message1"
		msg := <-ch2
		fmt.Printf("Received: %s\n", msg)
	}()
	
	go func() {
		ch2 <- "message2"
		msg := <-ch1
		fmt.Printf("Received: %s\n", msg)
	}()
	
	// Potential deadlock if channels are unbuffered and sends happen simultaneously
	time.Sleep(time.Second)
}

// UnboundedGoroutinePattern creates too many goroutines
func UnboundedGoroutinePattern(items []string) {
	var wg sync.WaitGroup
	
	// Problem: creating one goroutine per item without limiting concurrency
	for _, item := range items {
		wg.Add(1)
		go func(data string) {
			defer wg.Done()
			// Simulate work
			time.Sleep(time.Duration(rand.Intn(1000)) * time.Millisecond)
			fmt.Printf("Processed: %s\n", data)
		}(item)
	}
	
	wg.Wait()
}