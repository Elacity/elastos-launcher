#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif
#ifndef __NR_pidfd_send_signal
#define __NR_pidfd_send_signal 424
#endif

static int write_text(int fd, const char *text) {
  size_t len = strlen(text);
  size_t off = 0;
  while (off < len) {
    ssize_t n = write(fd, text + off, len - off);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    off += (size_t)n;
  }
  return 0;
}

static const char *errno_name(int err) {
  switch (err) {
  case ESRCH: return "ESRCH";
  case ENOSYS: return "ENOSYS";
  case EPERM: return "EPERM";
  case EINVAL: return "EINVAL";
  case EBADF: return "EBADF";
  default: return "EIO";
  }
}

static void report(int reply, int err) {
  char line[32];
  int n = snprintf(line, sizeof line, "errno %s\n", errno_name(err));
  if (n > 0 && (size_t)n < sizeof line) write_text(reply, line);
}

static int read_line(int fd, char *buf, size_t cap) {
  size_t n = 0;
  while (n + 1 < cap) {
    char c = 0;
    ssize_t r = read(fd, &c, 1);
    if (r < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (r == 0) return -1;
    buf[n++] = c;
    if (c == '\n') {
      buf[n] = '\0';
      return 0;
    }
  }
  return -1;
}

int main(int argc, char **argv) {
  char *end = NULL;
  long pid;
  int reply;
  int fd;
  int cmd;
  char line[32];
  if (argc != 4) return 2;
  prctl(PR_SET_PDEATHSIG, SIGKILL);
  if (getppid() == 1) return 2;
  alarm(2);
  errno = 0;
  pid = strtol(argv[1], &end, 10);
  if (errno || !argv[1][0] || (end && *end) || pid <= 0 || pid > 0x7fffffff) return 2;
  reply = open(argv[2], O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (reply < 0) return 2;
  fd = (int)syscall(__NR_pidfd_open, (int)pid, 0);
  if (fd < 0) {
    report(reply, errno);
    close(reply);
    return 1;
  }
  if (write_text(reply, "ready\n") != 0) {
    close(fd);
    close(reply);
    return 1;
  }
  cmd = open(argv[3], O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  alarm(0);
  if (cmd < 0) {
    report(reply, errno);
    close(fd);
    close(reply);
    return 1;
  }
  while (read_line(cmd, line, sizeof line) == 0) {
    int sig = 0;
    if (strcmp(line, "close\n") == 0) {
      close(fd);
      close(cmd);
      close(reply);
      return 0;
    }
    if (strcmp(line, "SIGTERM\n") == 0) sig = SIGTERM;
    else if (strcmp(line, "SIGKILL\n") == 0) sig = SIGKILL;
    else {
      report(reply, EINVAL);
      continue;
    }
    if (syscall(__NR_pidfd_send_signal, fd, sig, NULL, 0) != 0) report(reply, errno);
    else write_text(reply, "sent\n");
  }
  close(fd);
  close(cmd);
  close(reply);
  return 0;
}
