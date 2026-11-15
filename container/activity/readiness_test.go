package sub2apiactivity

import "testing"

func TestInitializationSignalLifecycle(t *testing.T) {
	generation := BeginInitialization()
	if Initialized() {
		t.Fatal("bootstrap is not ready")
	}
	MarkInitialized(generation)
	if !Initialized() {
		t.Fatal("completed bootstrap is ready, even with no models")
	}
	EndInitialization(generation)
	if Initialized() {
		t.Fatal("stopped service must not remain ready")
	}
}

func TestFailedInitializationStaysNotReady(t *testing.T) {
	generation := BeginInitialization()
	EndInitialization(generation)
	if Initialized() {
		t.Fatal("failed bootstrap became ready")
	}
}

func TestOldInitializationCannotChangeNewGeneration(t *testing.T) {
	old := BeginInitialization()
	next := BeginInitialization()
	MarkInitialized(old)
	if Initialized() {
		t.Fatal("old completion marked new service ready")
	}
	MarkInitialized(next)
	EndInitialization(old)
	if !Initialized() {
		t.Fatal("old shutdown cleared new service readiness")
	}
	EndInitialization(next)
}
