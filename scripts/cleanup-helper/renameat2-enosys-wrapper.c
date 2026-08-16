#define _GNU_SOURCE

#include <errno.h>

int __wrap_renameat2(int old_directory_fd, const char *old_path, int new_directory_fd,
                     const char *new_path, unsigned int flags);

int __wrap_renameat2(int old_directory_fd, const char *old_path, int new_directory_fd,
                     const char *new_path, unsigned int flags) {
    (void)old_directory_fd;
    (void)old_path;
    (void)new_directory_fd;
    (void)new_path;
    (void)flags;
    errno = ENOSYS;
    return -1;
}
