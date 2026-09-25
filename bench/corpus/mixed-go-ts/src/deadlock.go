package main

// deadlock is a guaranteed deadlock: an unbuffered channel is both sent to and
// received from in the same goroutine with no `go` statement. It fires
// channel-deadlock on the Go half of the mixed dispatch.
func deadlock() {
	ch := make(chan int)
	ch <- 1
	<-ch
}
