#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <unistd.h>

#define READY_PATH "/cleanup-root/.cleanup-helper-test-unlink-ready"
#define CONTINUE_PATH "/cleanup-root/.cleanup-helper-test-unlink-continue"
#define WAIT_ATTEMPTS 30000

int __real_unlinkat(int directory_fd, const char *path, int flags);
int __wrap_unlinkat(int directory_fd, const char *path, int flags);

int __wrap_unlinkat(int directory_fd, const char *path, int flags) {
    static bool paused = false;
    if (!paused) {
        paused = true;
        int marker_fd = open(READY_PATH, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (marker_fd < 0 || close(marker_fd) != 0) {
            return -1;
        }
        for (unsigned int attempt = 0U; attempt < WAIT_ATTEMPTS; attempt++) {
            if (access(CONTINUE_PATH, F_OK) == 0) {
                return __real_unlinkat(directory_fd, path, flags);
            }
            if (errno != ENOENT) {
                return -1;
            }
            usleep(1000U);
        }
        errno = ETIMEDOUT;
        return -1;
    }
    return __real_unlinkat(directory_fd, path, flags);
}
