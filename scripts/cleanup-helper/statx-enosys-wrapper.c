#include <errno.h>
#include <sys/syscall.h>

long __wrap_syscall(long number, ...);

long __wrap_syscall(long number, ...) {
    if (number == SYS_statx) {
        errno = ENOSYS;
        return -1;
    }

    errno = ENOSYS;
    return -1;
}
