#define _GNU_SOURCE

#if !defined(__linux__) || !defined(__x86_64__)
#error "cleanup-helper is supported only on linux/amd64"
#endif

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/stat.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/random.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef SYS_statx
#define SYS_statx 332
#endif

#define CLEANUP_ROOT "/cleanup-root"
#define MAX_CLEANUP_PASSES 3
#define MAX_CLAIM_ATTEMPTS 8
#define MAX_DIRECTORY_DEPTH 256
#define MAX_RELATIVE_PATH_LENGTH 4095
#define CLAIM_NAME_PREFIX ".local-ydb-cleanup-"
#define CLAIM_RANDOM_BYTES 16U
#define CLAIM_NAME_LENGTH (sizeof(CLAIM_NAME_PREFIX) - 1U + CLAIM_RANDOM_BYTES * 2U + 1U)

enum helper_exit_code {
    HELPER_OK = 0,
    HELPER_USAGE = 64,
    HELPER_POLICY = 65,
    HELPER_SYSTEM = 70,
};

static int open_confined_directory(int base_fd, const char *path, uint64_t root_mount_id);
static int cleanup_directory_contents(int directory_fd, unsigned int depth, uint64_t root_mount_id);

static void print_errno(const char *action, const char *path, int error_number) {
    fprintf(stderr, "cleanup-helper: %s '%s': %s\n", action, path, strerror(error_number));
}

static bool is_dot_component(const char *component, size_t length) {
    return (length == 1U && component[0] == '.') ||
           (length == 2U && component[0] == '.' && component[1] == '.');
}

static bool validate_relative_path(const char *path) {
    size_t path_length = strnlen(path, MAX_RELATIVE_PATH_LENGTH + 1U);
    if (path_length == 0U || path_length > MAX_RELATIVE_PATH_LENGTH || path[0] == '/' ||
        path[path_length - 1U] == '/') {
        return false;
    }

    const char *component = path;
    for (size_t index = 0U; index <= path_length; index++) {
        unsigned char current = (unsigned char)path[index];
        if (current != '\0' && (current == '\\' || current < 0x20U || current == 0x7fU)) {
            return false;
        }
        if (current != '/' && current != '\0') {
            continue;
        }

        size_t component_length = (size_t)(&path[index] - component);
        if (component_length == 0U || is_dot_component(component, component_length)) {
            return false;
        }
        component = &path[index + 1U];
    }
    return true;
}

static int read_mount_id(int directory_fd, uint64_t *mount_id) {
    struct statx status = {0};
    if (syscall(SYS_statx, directory_fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
                STATX_TYPE | STATX_INO | STATX_MNT_ID, &status) != 0) {
        return -1;
    }
    if ((status.stx_mask & STATX_MNT_ID) == 0U) {
        errno = EOPNOTSUPP;
        return -1;
    }
    *mount_id = status.stx_mnt_id;
    return 0;
}

static int open_confined_directory(int base_fd, const char *path, uint64_t root_mount_id) {
    /* Docker Desktop's amd64 emulation does not expose openat2. Opening one validated component at
       a time with O_NOFOLLOW pins traversal to directory fds; mount IDs provide NO_XDEV semantics. */
    char *path_copy = strdup(path);
    if (path_copy == NULL) {
        errno = ENOMEM;
        return -1;
    }
    int current_fd = fcntl(base_fd, F_DUPFD_CLOEXEC, 0);
    if (current_fd < 0) {
        free(path_copy);
        return -1;
    }

    char *save_pointer = NULL;
    for (char *component = strtok_r(path_copy, "/", &save_pointer); component != NULL;
         component = strtok_r(NULL, "/", &save_pointer)) {
        int next_fd = openat(current_fd, component,
                             O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (next_fd < 0) {
            int error_number = errno;
            if (error_number == ENOTDIR || error_number == ELOOP) {
                struct stat status;
                if (fstatat(current_fd, component, &status,
                            AT_SYMLINK_NOFOLLOW | AT_NO_AUTOMOUNT) == 0 &&
                    S_ISLNK(status.st_mode)) {
                    error_number = ELOOP;
                }
            }
            close(current_fd);
            free(path_copy);
            errno = error_number;
            return -1;
        }

        uint64_t mount_id = 0U;
        if (read_mount_id(next_fd, &mount_id) != 0) {
            int error_number = errno;
            close(next_fd);
            close(current_fd);
            free(path_copy);
            errno = error_number;
            return -1;
        }
        if (mount_id != root_mount_id) {
            close(next_fd);
            close(current_fd);
            free(path_copy);
            errno = EXDEV;
            return -1;
        }

        close(current_fd);
        current_fd = next_fd;
    }
    free(path_copy);
    return current_fd;
}

static int report_resolution_error(const char *path, int error_number, bool missing_is_ok) {
    if (missing_is_ok && error_number == ENOENT) {
        return HELPER_OK;
    }
    if (error_number == ENOSYS || error_number == EINVAL || error_number == EOPNOTSUPP) {
        fprintf(stderr,
                "cleanup-helper: statx mount confinement is unavailable while resolving '%s'; "
                "Linux STATX_MNT_ID support is required\n",
                path);
        return HELPER_SYSTEM;
    }
    if (error_number == EXDEV) {
        fprintf(stderr, "cleanup-helper: refusing to cross a mount point while resolving '%s'\n", path);
        return HELPER_POLICY;
    }
    if (error_number == ELOOP) {
        fprintf(stderr, "cleanup-helper: refusing a symlink while resolving '%s'\n", path);
        return HELPER_POLICY;
    }
    if (error_number == ENOTDIR) {
        fprintf(stderr, "cleanup-helper: target path component is not a directory: '%s'\n", path);
        return HELPER_POLICY;
    }
    print_errno("cannot resolve", path, error_number);
    return HELPER_SYSTEM;
}

static bool same_identity(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
           ((left->st_mode & S_IFMT) == (right->st_mode & S_IFMT));
}

static int open_directory_stream(int directory_fd, DIR **stream) {
    int stream_fd = openat(directory_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (stream_fd < 0) {
        print_errno("cannot reopen directory", ".", errno);
        return HELPER_SYSTEM;
    }
    *stream = fdopendir(stream_fd);
    if (*stream == NULL) {
        int error_number = errno;
        close(stream_fd);
        print_errno("cannot read directory", ".", error_number);
        return HELPER_SYSTEM;
    }
    return HELPER_OK;
}

static int directory_is_empty(int directory_fd, bool *empty) {
    DIR *stream = NULL;
    int result = open_directory_stream(directory_fd, &stream);
    if (result != HELPER_OK) {
        return result;
    }

    *empty = true;
    errno = 0;
    for (;;) {
        struct dirent *entry = readdir(stream);
        if (entry == NULL) {
            break;
        }
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
            *empty = false;
            break;
        }
    }
    int read_error = errno;
    if (closedir(stream) != 0 && read_error == 0) {
        read_error = errno;
    }
    if (read_error != 0) {
        print_errno("cannot finish reading directory", ".", read_error);
        return HELPER_SYSTEM;
    }
    return HELPER_OK;
}

static int unlink_non_directory(int directory_fd, const char *name) {
    if (unlinkat(directory_fd, name, 0) == 0 || errno == ENOENT) {
        return HELPER_OK;
    }

    int error_number = errno;
    if (error_number == EBUSY) {
        fprintf(stderr, "cleanup-helper: refusing mounted entry '%s'\n", name);
        return HELPER_POLICY;
    }
    if (error_number == EISDIR || error_number == EPERM) {
        struct stat current;
        if (fstatat(directory_fd, name, &current,
                    AT_SYMLINK_NOFOLLOW | AT_NO_AUTOMOUNT) != 0) {
            if (errno == ENOENT) {
                return HELPER_OK;
            }
            print_errno("cannot inspect changed entry", name, errno);
            return HELPER_SYSTEM;
        }
        if (S_ISDIR(current.st_mode)) {
            return HELPER_OK;
        }
    }
    print_errno("cannot unlink entry", name, error_number);
    return HELPER_SYSTEM;
}

static int remove_child_directory(int parent_fd, const char *name, unsigned int depth,
                                  uint64_t root_mount_id) {
    int child_fd = open_confined_directory(parent_fd, name, root_mount_id);
    if (child_fd < 0) {
        int error_number = errno;
        if (error_number == ENOENT) {
            return HELPER_OK;
        }
        if (error_number == ENOTDIR || error_number == ELOOP) {
            return unlink_non_directory(parent_fd, name);
        }
        return report_resolution_error(name, error_number, false);
    }

    struct stat identity;
    if (fstat(child_fd, &identity) != 0) {
        int error_number = errno;
        close(child_fd);
        print_errno("cannot inspect directory", name, error_number);
        return HELPER_SYSTEM;
    }

    for (unsigned int pass = 0U; pass < MAX_CLEANUP_PASSES; pass++) {
        int result = cleanup_directory_contents(child_fd, depth + 1U, root_mount_id);
        if (result != HELPER_OK) {
            close(child_fd);
            return result;
        }

        struct stat current;
        if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW | AT_NO_AUTOMOUNT) != 0) {
            int error_number = errno;
            close(child_fd);
            if (error_number == ENOENT) {
                return HELPER_OK;
            }
            print_errno("cannot revalidate directory", name, error_number);
            return HELPER_SYSTEM;
        }
        if (!same_identity(&identity, &current)) {
            close(child_fd);
            fprintf(stderr, "cleanup-helper: directory identity changed during cleanup: '%s'\n", name);
            return HELPER_POLICY;
        }

        if (unlinkat(parent_fd, name, AT_REMOVEDIR) == 0 || errno == ENOENT) {
            close(child_fd);
            return HELPER_OK;
        }
        if (errno == EBUSY) {
            close(child_fd);
            fprintf(stderr, "cleanup-helper: refusing mounted directory '%s'\n", name);
            return HELPER_POLICY;
        }
        if (errno != ENOTEMPTY && errno != EEXIST) {
            int error_number = errno;
            close(child_fd);
            print_errno("cannot remove directory", name, error_number);
            return HELPER_SYSTEM;
        }
    }

    close(child_fd);
    fprintf(stderr, "cleanup-helper: directory changed repeatedly during cleanup: '%s'\n", name);
    return HELPER_POLICY;
}

static int cleanup_directory_entry(int directory_fd, const char *name, unsigned int depth,
                                   uint64_t root_mount_id) {
    struct stat entry_status;
    if (fstatat(directory_fd, name, &entry_status,
                AT_SYMLINK_NOFOLLOW | AT_NO_AUTOMOUNT) != 0) {
        if (errno == ENOENT) {
            return HELPER_OK;
        }
        print_errno("cannot inspect entry", name, errno);
        return HELPER_SYSTEM;
    }

    if (S_ISDIR(entry_status.st_mode)) {
        return remove_child_directory(directory_fd, name, depth, root_mount_id);
    }
    return unlink_non_directory(directory_fd, name);
}

static int cleanup_directory_contents(int directory_fd, unsigned int depth,
                                      uint64_t root_mount_id) {
    if (depth > MAX_DIRECTORY_DEPTH) {
        fprintf(stderr, "cleanup-helper: directory nesting exceeds the safety limit\n");
        return HELPER_POLICY;
    }

    for (unsigned int pass = 0U; pass < MAX_CLEANUP_PASSES; pass++) {
        DIR *stream = NULL;
        int result = open_directory_stream(directory_fd, &stream);
        if (result != HELPER_OK) {
            return result;
        }

        for (;;) {
            errno = 0;
            struct dirent *entry = readdir(stream);
            if (entry == NULL) {
                break;
            }
            if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
                continue;
            }
            result = cleanup_directory_entry(directory_fd, entry->d_name, depth, root_mount_id);
            if (result != HELPER_OK) {
                closedir(stream);
                return result;
            }
        }
        int read_error = errno;
        if (closedir(stream) != 0 && read_error == 0) {
            read_error = errno;
        }
        if (read_error != 0) {
            print_errno("cannot finish reading directory", ".", read_error);
            return HELPER_SYSTEM;
        }

        bool empty = false;
        result = directory_is_empty(directory_fd, &empty);
        if (result != HELPER_OK || empty) {
            return result;
        }
    }

    fprintf(stderr, "cleanup-helper: directory changed repeatedly during cleanup\n");
    return HELPER_POLICY;
}

static int split_target_path(const char *relative_path, char **storage, const char **parent_path,
                             const char **target_name) {
    *storage = strdup(relative_path);
    if (*storage == NULL) {
        fprintf(stderr, "cleanup-helper: cannot allocate target path\n");
        return HELPER_SYSTEM;
    }

    char *last_separator = strrchr(*storage, '/');
    if (last_separator == NULL) {
        *parent_path = NULL;
        *target_name = *storage;
        return HELPER_OK;
    }
    *last_separator = '\0';
    *parent_path = *storage;
    *target_name = last_separator + 1;
    return HELPER_OK;
}

static int generate_claim_name(char *name, size_t name_size) {
    static const char hex[] = "0123456789abcdef";
    unsigned char random_bytes[CLAIM_RANDOM_BYTES];
    size_t offset = 0U;
    while (offset < sizeof(random_bytes)) {
        ssize_t count = getrandom(&random_bytes[offset], sizeof(random_bytes) - offset, 0U);
        if (count < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (count == 0) {
            errno = EIO;
            return -1;
        }
        offset += (size_t)count;
    }

    if (name_size < CLAIM_NAME_LENGTH) {
        errno = ENAMETOOLONG;
        return -1;
    }
    size_t prefix_length = sizeof(CLAIM_NAME_PREFIX) - 1U;
    memcpy(name, CLAIM_NAME_PREFIX, prefix_length);
    for (size_t index = 0U; index < sizeof(random_bytes); index++) {
        name[prefix_length + index * 2U] = hex[random_bytes[index] >> 4U];
        name[prefix_length + index * 2U + 1U] = hex[random_bytes[index] & 0x0fU];
    }
    name[CLAIM_NAME_LENGTH - 1U] = '\0';
    return 0;
}

static int claim_target_name(int root_fd, int parent_fd, const char *target_name,
                             const char *relative_path, char *claim_name,
                             size_t claim_name_size, bool *claimed) {
    *claimed = false;
    for (unsigned int attempt = 0U; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
        if (generate_claim_name(claim_name, claim_name_size) != 0) {
            print_errno("cannot generate private target claim", relative_path, errno);
            return HELPER_SYSTEM;
        }
        if (renameat2(parent_fd, target_name, root_fd, claim_name, RENAME_NOREPLACE) == 0) {
            *claimed = true;
            return HELPER_OK;
        }

        int error_number = errno;
        if (error_number == EEXIST) {
            continue;
        }
        if (error_number == ENOENT) {
            return HELPER_OK;
        }
        if (error_number == ENOSYS || error_number == EINVAL || error_number == EOPNOTSUPP) {
            fprintf(stderr,
                    "cleanup-helper: atomic target claiming is unavailable for '%s'; "
                    "Linux renameat2 RENAME_NOREPLACE support is required\n",
                    relative_path);
            return HELPER_SYSTEM;
        }
        if (error_number == EXDEV) {
            fprintf(stderr, "cleanup-helper: refusing to claim target across a mount: '%s'\n",
                    relative_path);
            return HELPER_POLICY;
        }
        if (error_number == EBUSY) {
            fprintf(stderr, "cleanup-helper: refusing mounted target '%s'\n", relative_path);
            return HELPER_POLICY;
        }
        print_errno("cannot claim target", relative_path, error_number);
        return HELPER_SYSTEM;
    }

    fprintf(stderr, "cleanup-helper: cannot allocate a unique private claim for '%s'\n",
            relative_path);
    return HELPER_SYSTEM;
}

static int open_anchored_parent(int root_fd, const char *parent_path, int original_parent_fd,
                                uint64_t root_mount_id) {
    int anchored_fd = parent_path == NULL
        ? fcntl(root_fd, F_DUPFD_CLOEXEC, 0)
        : open_confined_directory(root_fd, parent_path, root_mount_id);
    if (anchored_fd < 0) {
        return -1;
    }

    struct stat original_identity;
    struct stat anchored_identity;
    if (fstat(original_parent_fd, &original_identity) != 0 ||
        fstat(anchored_fd, &anchored_identity) != 0) {
        int error_number = errno;
        close(anchored_fd);
        errno = error_number;
        return -1;
    }
    if (!same_identity(&original_identity, &anchored_identity)) {
        close(anchored_fd);
        errno = ESTALE;
        return -1;
    }
    return anchored_fd;
}

static bool restore_claimed_target(int root_fd, const char *claim_name, const char *parent_path,
                                   int original_parent_fd, const char *target_name,
                                   const char *relative_path, uint64_t root_mount_id) {
    int anchored_parent_fd = open_anchored_parent(root_fd, parent_path, original_parent_fd,
                                                  root_mount_id);
    if (anchored_parent_fd < 0) {
        fprintf(stderr,
                "cleanup-helper: target cleanup failed and its original parent is no longer "
                "anchored for '%s'; inspect '/cleanup-root/%s' before retrying\n",
                relative_path, claim_name);
        return false;
    }

    if (renameat2(root_fd, claim_name, anchored_parent_fd, target_name, RENAME_NOREPLACE) == 0) {
        close(anchored_parent_fd);
        return true;
    }
    int error_number = errno;
    close(anchored_parent_fd);
    fprintf(stderr,
            "cleanup-helper: target cleanup failed and the claimed target could not be restored "
            "for '%s': %s; inspect '/cleanup-root/%s' before retrying\n",
            relative_path, strerror(error_number), claim_name);
    return false;
}

static int remove_target_directory(int root_fd, const char *relative_path, uint64_t root_mount_id) {
    char *path_storage = NULL;
    const char *parent_path = NULL;
    const char *target_name = NULL;
    int result = split_target_path(relative_path, &path_storage, &parent_path, &target_name);
    if (result != HELPER_OK) {
        return result;
    }

    int parent_fd = parent_path == NULL
        ? fcntl(root_fd, F_DUPFD_CLOEXEC, 0)
        : open_confined_directory(root_fd, parent_path, root_mount_id);
    if (parent_fd < 0) {
        int error_number = errno;
        free(path_storage);
        if (parent_path == NULL) {
            print_errno("cannot duplicate cleanup root", CLEANUP_ROOT, error_number);
            return HELPER_SYSTEM;
        }
        return report_resolution_error(parent_path, error_number, true);
    }

    int target_fd = open_confined_directory(parent_fd, target_name, root_mount_id);
    if (target_fd < 0) {
        int error_number = errno;
        close(parent_fd);
        free(path_storage);
        if (error_number == ENOENT) {
            return HELPER_OK;
        }
        if (error_number == ENOTDIR) {
            fprintf(stderr, "cleanup-helper: target must be a directory: '%s'\n", relative_path);
            return HELPER_POLICY;
        }
        return report_resolution_error(relative_path, error_number, false);
    }

    struct stat identity;
    if (fstat(target_fd, &identity) != 0) {
        int error_number = errno;
        close(target_fd);
        close(parent_fd);
        free(path_storage);
        print_errno("cannot inspect target", relative_path, error_number);
        return HELPER_SYSTEM;
    }

    char claim_name[CLAIM_NAME_LENGTH];
    bool claimed = false;
    result = claim_target_name(root_fd, parent_fd, target_name, relative_path, claim_name,
                               sizeof(claim_name), &claimed);
    if (result != HELPER_OK || !claimed) {
        close(target_fd);
        close(parent_fd);
        free(path_storage);
        return result;
    }

    struct stat claimed_identity;
    int claim_status = fstatat(root_fd, claim_name, &claimed_identity,
                               AT_SYMLINK_NOFOLLOW | AT_NO_AUTOMOUNT);
    if (claim_status != 0 || !same_identity(&identity, &claimed_identity)) {
        int error_number = claim_status == 0 ? 0 : errno;
        bool restored = restore_claimed_target(root_fd, claim_name, parent_path, parent_fd,
                                               target_name, relative_path, root_mount_id);
        close(target_fd);
        close(parent_fd);
        free(path_storage);
        if (!restored) {
            return HELPER_SYSTEM;
        }
        if (error_number != 0) {
            print_errno("cannot validate claimed target", relative_path, error_number);
        } else {
            fprintf(stderr, "cleanup-helper: target identity changed before it was claimed: '%s'\n",
                    relative_path);
        }
        return HELPER_POLICY;
    }

    int claimed_fd = open_confined_directory(root_fd, claim_name, root_mount_id);
    if (claimed_fd < 0) {
        int error_number = errno;
        bool restored = restore_claimed_target(root_fd, claim_name, parent_path, parent_fd,
                                               target_name, relative_path, root_mount_id);
        close(target_fd);
        close(parent_fd);
        free(path_storage);
        if (!restored) {
            return HELPER_SYSTEM;
        }
        return report_resolution_error(relative_path, error_number, false);
    }

    struct stat opened_claim_identity;
    int opened_claim_status = fstat(claimed_fd, &opened_claim_identity);
    if (opened_claim_status != 0 || !same_identity(&identity, &opened_claim_identity)) {
        int error_number = opened_claim_status == 0 ? 0 : errno;
        close(claimed_fd);
        bool restored = restore_claimed_target(root_fd, claim_name, parent_path, parent_fd,
                                               target_name, relative_path, root_mount_id);
        close(target_fd);
        close(parent_fd);
        free(path_storage);
        if (!restored) {
            return HELPER_SYSTEM;
        }
        if (error_number != 0) {
            print_errno("cannot inspect claimed target", relative_path, error_number);
        } else {
            fprintf(stderr, "cleanup-helper: claimed target identity changed: '%s'\n",
                    relative_path);
        }
        return HELPER_POLICY;
    }
    close(target_fd);

    bool exhausted_passes = true;
    for (unsigned int pass = 0U; pass < MAX_CLEANUP_PASSES; pass++) {
        result = cleanup_directory_contents(claimed_fd, 0U, root_mount_id);
        if (result != HELPER_OK) {
            exhausted_passes = false;
            break;
        }

        struct stat current;
        if (fstatat(root_fd, claim_name, &current,
                    AT_SYMLINK_NOFOLLOW | AT_NO_AUTOMOUNT) != 0) {
            print_errno("cannot revalidate claimed target", relative_path, errno);
            result = HELPER_POLICY;
            exhausted_passes = false;
            break;
        }
        if (!same_identity(&identity, &current)) {
            fprintf(stderr, "cleanup-helper: target identity changed during cleanup: '%s'\n",
                    relative_path);
            result = HELPER_POLICY;
            exhausted_passes = false;
            break;
        }

        if (unlinkat(root_fd, claim_name, AT_REMOVEDIR) == 0) {
            result = HELPER_OK;
            exhausted_passes = false;
            break;
        }
        if (errno == EBUSY) {
            fprintf(stderr, "cleanup-helper: refusing mounted target '%s'\n", relative_path);
            result = HELPER_POLICY;
            exhausted_passes = false;
            break;
        }
        if (errno != ENOTEMPTY && errno != EEXIST) {
            print_errno("cannot remove target", relative_path, errno);
            result = HELPER_SYSTEM;
            exhausted_passes = false;
            break;
        }
    }
    if (exhausted_passes) {
        result = HELPER_POLICY;
        fprintf(stderr, "cleanup-helper: target changed repeatedly during cleanup: '%s'\n",
                relative_path);
    }

    close(claimed_fd);
    if (result != HELPER_OK &&
        !restore_claimed_target(root_fd, claim_name, parent_path, parent_fd, target_name,
                                relative_path, root_mount_id)) {
        result = HELPER_SYSTEM;
    }
    close(parent_fd);
    free(path_storage);
    return result;
}

int main(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], CLEANUP_ROOT) != 0) {
        fprintf(stderr, "usage: cleanup-helper /cleanup-root RELATIVE_DIRECTORY\n");
        return HELPER_USAGE;
    }
    if (!validate_relative_path(argv[2])) {
        fprintf(stderr, "cleanup-helper: target must be a normalized relative directory path\n");
        return HELPER_USAGE;
    }

    int root_fd = open(CLEANUP_ROOT, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (root_fd < 0) {
        print_errno("cannot open cleanup root", CLEANUP_ROOT, errno);
        return HELPER_SYSTEM;
    }

    uint64_t root_mount_id = 0U;
    if (read_mount_id(root_fd, &root_mount_id) != 0) {
        int error_number = errno;
        close(root_fd);
        if (error_number == ENOSYS || error_number == EINVAL || error_number == EOPNOTSUPP) {
            fprintf(stderr,
                    "cleanup-helper: statx mount confinement is unavailable; Linux STATX_MNT_ID "
                    "support is required\n");
            return HELPER_SYSTEM;
        }
        print_errno("cannot identify cleanup root mount", CLEANUP_ROOT, error_number);
        return HELPER_SYSTEM;
    }

    int result = remove_target_directory(root_fd, argv[2], root_mount_id);
    close(root_fd);
    return result;
}
