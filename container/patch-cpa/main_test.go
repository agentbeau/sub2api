package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExactReplacementRejectsMissingAndDuplicateAnchors(t *testing.T) {
	for _, source := range []string{"changed", "hook hook"} {
		if _, errReplace := replaceExact(source, replacement{"hook", "guarded"}); errReplace == nil {
			t.Fatalf("accepted changed source %q", source)
		}
	}
	result, errReplace := replaceExact("before hook after", replacement{"hook", "guarded"})
	if errReplace != nil || result != "before guarded after" {
		t.Fatalf("result=%q, error=%v", result, errReplace)
	}
}

func TestFailedValidationDoesNotPartiallyPatchSource(t *testing.T) {
	for _, badSource := range []string{"package example\nconst other = 1\n", "package example\nconst value = 1\n// const value = 1\n"} {
		root := t.TempDir()
		original := "package example\nconst value = 1\n"
		for name, source := range map[string]string{"first.go": original, "second.go": badSource} {
			if errWrite := os.WriteFile(filepath.Join(root, name), []byte(source), 0o600); errWrite != nil {
				t.Fatal(errWrite)
			}
		}
		patches := []filePatch{
			{"first.go", []replacement{{"const value = 1", "const value = 2"}}},
			{"second.go", []replacement{{"const value = 1", "const value = 2"}}},
		}
		if errPatch := applyPlan(root, patches); errPatch == nil {
			t.Fatal("accepted drifted source")
		}
		data, errRead := os.ReadFile(filepath.Join(root, "first.go"))
		if errRead != nil || string(data) != original {
			t.Fatalf("partially patched first file: %q, %v", data, errRead)
		}
	}
}

func TestInvalidGeneratedGoDoesNotWriteAnyFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "source.go")
	original := "package example\nconst value = 1\n"
	if errWrite := os.WriteFile(path, []byte(original), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	if errPatch := applyPlan(root, []filePatch{{"source.go", []replacement{{"const value = 1", "invalid go {}"}}}}); errPatch == nil {
		t.Fatal("accepted invalid Go")
	}
	data, _ := os.ReadFile(path)
	if string(data) != original {
		t.Fatal("invalid Go overwrote original source")
	}
}
