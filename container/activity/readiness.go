package sub2apiactivity

import "sync"

// Process readiness is separate from HTTP liveness. Model-less configurations
// are valid: completion of bootstrap, not a non-empty model list, is the signal.
var initialization struct {
	sync.RWMutex
	generation uint64
	ready      bool
}

func BeginInitialization() uint64 {
	initialization.Lock()
	defer initialization.Unlock()
	initialization.generation++
	initialization.ready = false
	return initialization.generation
}

func MarkInitialized(generation uint64) {
	initialization.Lock()
	defer initialization.Unlock()
	if initialization.generation == generation {
		initialization.ready = true
	}
}

func EndInitialization(generation uint64) {
	initialization.Lock()
	defer initialization.Unlock()
	if initialization.generation == generation {
		initialization.ready = false
	}
}

func Initialized() bool {
	initialization.RLock()
	defer initialization.RUnlock()
	return initialization.ready
}
