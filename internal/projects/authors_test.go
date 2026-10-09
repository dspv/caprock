package projects

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestParseAuthorsCountsPeopleNotAddresses(t *testing.T) {
	out := []byte("Ana Lima\tana@work.example\n" +
		"ana lima\tana@home.example\n" +
		"Ben\tben@x.example\n" +
		"dependabot[bot]\t49699333+dependabot[bot]@users.noreply.github.com\n" +
		"GitHub\tnoreply@github.com\n" +
		"\t\n")
	got := parseAuthors(out)
	if len(got) != 2 || !got["ana lima"] || !got["ben"] {
		t.Fatalf("authors = %v, want ana lima and ben", got)
	}
}

// commitAs makes one commit in dir authored by name.
func commitAs(t *testing.T, dir, name, file string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(name), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", file}, {"commit", "-q", "-m", file}} {
		c := exec.Command("git", append([]string{"-C", dir}, args...)...)
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME="+name, "GIT_AUTHOR_EMAIL="+name+"@x",
			"GIT_COMMITTER_NAME="+name, "GIT_COMMITTER_EMAIL="+name+"@x", "GIT_CONFIG_NOSYSTEM=1")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

func TestCountAuthorsAcrossRepositories(t *testing.T) {
	needGit(t)
	base := t.TempDir()
	solo := newRepo(t, filepath.Join(base, "solo"))
	shared := newRepo(t, filepath.Join(base, "shared"))
	commitAs(t, shared, "colleague", "g")

	one := countAuthors(context.Background(), []string{solo}, 30, 10*time.Second)
	if one.Authors != 1 || one.Repos != 1 {
		t.Fatalf("solo = %+v, want 1 author in 1 repo", one)
	}
	both := countAuthors(context.Background(), []string{solo, shared, filepath.Join(base, "missing")}, 30, 10*time.Second)
	if both.Authors != 2 || both.Repos != 2 {
		t.Fatalf("both = %+v, want 2 authors in 2 readable repos", both)
	}
}
