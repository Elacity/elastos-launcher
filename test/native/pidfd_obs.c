#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef PIDFD_ALARM_LOG
#error PIDFD_ALARM_LOG is required
#endif
#ifndef PIDFD_SIGNAL_LOG
#error PIDFD_SIGNAL_LOG is required
#endif
#ifndef PIDFD_PRCTL_LOG
#error PIDFD_PRCTL_LOG is required
#endif
#ifndef PIDFD_PID_LOG
#error PIDFD_PID_LOG is required
#endif

static void pidfd_record(const char *path, const char *line) {
  FILE *file = fopen(path, "a");
  if (!file) return;
  fputs(line, file);
  fclose(file);
}

static void pidfd_note_self(void) {
  char line[32];
  int n = snprintf(line, sizeof line, "%ld\n", (long)getpid());
  if (n > 0) pidfd_record(PIDFD_PID_LOG, line);
}

unsigned int pidfd_test_alarm(unsigned int seconds) {
  char line[32];
  int n = snprintf(line, sizeof line, "%u\n", seconds);
  if (n > 0) pidfd_record(PIDFD_ALARM_LOG, line);
#ifdef PIDFD_PASSTHROUGH_ALARM
  return alarm(seconds);
#else
  {
    struct itimerval value;
    if (seconds >= 60) seconds = 1;
    memset(&value, 0, sizeof value);
    value.it_value.tv_sec = seconds;
    setitimer(ITIMER_REAL, &value, NULL);
  }
  return 0;
#endif
}

int pidfd_test_prctl(int option, unsigned long arg) {
  char line[64];
  int n = snprintf(line, sizeof line, "%d %lu\n", option, arg);
  pidfd_note_self();
  if (n > 0) pidfd_record(PIDFD_PRCTL_LOG, line);
  return 0;
}

int pidfd_test_syscall(int number, ...) {
  va_list args;
  char line[32];
  int sig;
  int n;
  va_start(args, number);
  if (number == 434) {
    (void)va_arg(args, int);
    (void)va_arg(args, int);
    va_end(args);
    return open("/dev/null", O_RDONLY | O_CLOEXEC);
  }
  if (number == 424) {
    (void)va_arg(args, int);
    sig = va_arg(args, int);
    va_end(args);
    n = snprintf(line, sizeof line, "%d\n", sig);
    if (n > 0) pidfd_record(PIDFD_SIGNAL_LOG, line);
    return 0;
  }
  va_end(args);
  errno = ENOSYS;
  return -1;
}
