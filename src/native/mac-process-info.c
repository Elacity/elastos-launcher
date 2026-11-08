#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>

/* Read the kernel executable path between two birth-time observations. */
int main(int argc, char **argv) {
    if (argc != 2) return 1;
    char *end;
    errno = 0;
    long pid = strtol(argv[1], &end, 10);
    if (errno || !*argv[1] || *end || pid <= 0 || pid > INT_MAX) return 1;
    struct proc_bsdinfo before, after;
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)
        || proc_pidpath((int)pid, executable, sizeof(executable)) <= 0
        || proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)
        || before.pbi_start_tvsec != after.pbi_start_tvsec
        || before.pbi_start_tvusec != after.pbi_start_tvusec) return 1;
    printf("%llu.%06llu\n%s", (unsigned long long)after.pbi_start_tvsec,
        (unsigned long long)after.pbi_start_tvusec, executable);
    return 0;
}
