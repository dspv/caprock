// Command fakegh stands in for the GitHub CLI in tests of
// internal/templates, so no test ever runs the real gh against GitHub. It is
// Go so it runs on Windows too. Everything is driven by the environment:
//
//	FAKEGH_DIR          a folder of repositories: <owner>__<name>/bare.git,
//	                    <owner>__<name>/view.json (what `repo view` prints),
//	                    <owner>__<name>/contents/<path> (what `api` prints)
//	FAKEGH_LOGIN        the signed-in user; unset is signed out
//	FAKEGH_EMPTY_CLONES the first N clones come back as empty repositories,
//	                    as GitHub's are before it has filled a new one in
//	FAKEGH_CLONE_FAIL   every clone fails
//	FAKEGH_CREATE_FAIL  every repo create fails
//
// Every call is appended to <FAKEGH_DIR>/calls.log, one line each.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func main() {
	dir := os.Getenv("FAKEGH_DIR")
	args := os.Args[1:]
	if dir != "" {
		if f, err := os.OpenFile(filepath.Join(dir, "calls.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			fmt.Fprintln(f, strings.Join(args, " "))
			_ = f.Close()
		}
	}
	os.Exit(run(dir, args))
}

func repoDir(dir, repo string) string {
	return filepath.Join(dir, strings.Replace(repo, "/", "__", 1))
}

func fail(format string, a ...any) int {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	return 1
}

func run(dir string, args []string) int {
	if len(args) >= 2 && args[0] == "config" && args[1] == "get" {
		login := os.Getenv("FAKEGH_LOGIN")
		if login == "" {
			return fail(`could not find key "user"`)
		}
		fmt.Println(login)
		return 0
	}
	if os.Getenv("FAKEGH_LOGIN") == "" {
		return fail("To get started with GitHub CLI, please run:  gh auth login")
	}
	switch {
	case len(args) >= 3 && args[0] == "repo" && args[1] == "view":
		b, err := os.ReadFile(filepath.Join(repoDir(dir, args[2]), "view.json"))
		if err != nil {
			return fail("GraphQL: Could not resolve to a Repository with the name '%s'. (repository)", args[2])
		}
		_, _ = os.Stdout.Write(b)
		return 0
	case len(args) >= 1 && args[0] == "api":
		path := args[len(args)-1] // repos/<o>/<n>/contents/<file> or repos/<o>/<n>/readme
		parts := strings.SplitN(path, "/", 4)
		if len(parts) < 4 || parts[0] != "repos" {
			return fail("unexpected api path %s", path)
		}
		rel := strings.TrimPrefix(parts[3], "contents/")
		if parts[3] == "readme" {
			rel = "README.md"
		}
		b, err := os.ReadFile(filepath.Join(repoDir(dir, parts[1]+"/"+parts[2]), "contents", filepath.FromSlash(rel)))
		if err != nil {
			return fail("gh: Not Found (HTTP 404)")
		}
		_, _ = os.Stdout.Write(b)
		return 0
	case len(args) >= 5 && args[0] == "repo" && args[1] == "create" && args[3] == "--template":
		if os.Getenv("FAKEGH_CREATE_FAIL") != "" {
			return fail("HTTP 502: Bad Gateway")
		}
		dest := repoDir(dir, args[2])
		if _, err := os.Stat(dest); err == nil {
			return fail("GraphQL: Name already exists on this account (createRepositoryFromTemplate)")
		}
		src := filepath.Join(repoDir(dir, args[4]), "bare.git")
		if out, err := exec.Command("git", "clone", "-q", "--bare", src, filepath.Join(dest, "bare.git")).CombinedOutput(); err != nil {
			return fail("could not copy the template: %s", out)
		}
		fmt.Printf("https://github.com/%s\n", args[2])
		return 0
	case len(args) >= 4 && args[0] == "repo" && args[1] == "clone":
		if os.Getenv("FAKEGH_CLONE_FAIL") != "" {
			return fail("fatal: unable to access 'https://github.com/%s/': Could not resolve host: github.com", args[2])
		}
		n := bump(filepath.Join(dir, "clones"))
		if empty, _ := strconv.Atoi(os.Getenv("FAKEGH_EMPTY_CLONES")); n <= empty {
			fmt.Fprintln(os.Stderr, "warning: You appear to have cloned an empty repository.")
			if out, err := exec.Command("git", "init", "-q", args[3]).CombinedOutput(); err != nil {
				return fail("%s", out)
			}
			return 0
		}
		gitArgs := append([]string{"clone"}, args[5:]...)
		gitArgs = append(gitArgs, filepath.Join(repoDir(dir, args[2]), "bare.git"), args[3])
		cmd := exec.Command("git", gitArgs...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return 1
		}
		return 0
	}
	return fail("fakegh: unknown command: %s", strings.Join(args, " "))
}

// bump adds one to the count in file and returns it.
func bump(file string) int {
	b, _ := os.ReadFile(file)
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	n++
	_ = os.WriteFile(file, []byte(strconv.Itoa(n)), 0o644)
	return n
}
