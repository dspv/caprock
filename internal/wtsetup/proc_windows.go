package wtsetup

import (
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"unsafe"

	"github.com/dspv/caprock/internal/hidewin"
	"golang.org/x/sys/windows"
)

// shellCommand runs script through cmd.exe. The command line is given whole
// (/s /c "<script>"), as cmd.exe expects, rather than through Go's argument
// quoting, which cmd.exe does not read.
func shellCommand(script string) *exec.Cmd {
	comspec := os.Getenv("ComSpec")
	if comspec == "" {
		comspec = "cmd.exe"
	}
	cmd := exec.Command(comspec)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `"` + comspec + `" /d /s /c "` + script + `"`}
	hidewin.Hide(cmd)
	return cmd
}

// stopTree ends the script and everything it started. Windows has no
// process groups to signal; taskkill /T walks the tree.
func stopTree(cmd *exec.Cmd, force bool) {
	if cmd.Process == nil {
		return
	}
	args := []string{"/T", "/PID", strconv.Itoa(cmd.Process.Pid)}
	if force {
		args = append([]string{"/F"}, args...)
	}
	_ = hidewin.Command("taskkill", args...).Run()
	if force {
		_ = cmd.Process.Kill()
	}
}

// become starts the agent and waits for it: Windows cannot replace a
// process. This process joins a job that kills everything in it when its
// last handle closes, so stopping the session (which ends this process) ends
// the agent too, and nothing outlives the terminal.
func become(args []string) error {
	killWithMe()
	path, err := exec.LookPath(args[0])
	if err != nil {
		return err
	}
	cmd := exec.Command(path, args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Ctrl+C is the agent's to handle; the console delivers it to both.
	signal.Ignore(os.Interrupt)
	if err := cmd.Run(); err != nil {
		return err
	}
	return nil
}

// killWithMe puts this process in a kill-on-close job. Best effort: without
// it the agent still runs, it merely could outlive a killed wrapper.
func killWithMe() {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		_ = windows.CloseHandle(job)
	}
	// The handle is deliberately kept open for the life of the process: its
	// closing, at exit, is what ends the job's other members.
}
