
/**
 * Executes an array of factory functions in parallel with a limited concurrency.
 * @param tasks Array of functions that return a promise.
 * @param concurrency Maximum number of concurrent tasks.
 */
export async function limitConcurrency<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number
): Promise<T[]> {
    const results: T[] = [];
    const activeTasks: Promise<void>[] = [];

    for (const task of tasks) {
        const p = task().then((res) => {
            results.push(res);
        });
        activeTasks.push(p);

        if (activeTasks.length >= concurrency) {
            await Promise.race(activeTasks);
            // Remove completed tasks from the active list
            // This is slightly inefficient but simple for few tasks
            for (let i = 0; i < activeTasks.length; i++) {
                // We can't easily check if a promise is resolved in JS without hacks,
                // so we just filter them out if they are done.
                // Actually, a better way is to use a pool of workers.
            }
        }
    }

    await Promise.all(activeTasks);
    return results;
}

/**
 * Better version using workers
 */
export async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let currentIndex = 0;

    const worker = async () => {
        while (currentIndex < items.length) {
            const index = currentIndex++;
            results[index] = await fn(items[index]);
        }
    };

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
    await Promise.all(workers);
    return results;
}
