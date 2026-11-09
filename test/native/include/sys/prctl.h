#ifndef PIDFD_TEST_PRCTL_H
#define PIDFD_TEST_PRCTL_H

#define PR_SET_PDEATHSIG 1

int prctl(int option, unsigned long arg);

#endif
