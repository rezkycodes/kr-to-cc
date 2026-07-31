/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Combine an optional parent signal with a timeout in a Node 18 compatible way.
 * Call cleanup once the operation completes to release timers/listeners.
 */
export function createAbortContext(parentSignal, timeoutMs) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();

    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();

    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timeout);
            parentSignal?.removeEventListener('abort', abortFromParent);
        }
    };
}
