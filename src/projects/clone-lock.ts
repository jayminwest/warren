/**
 * Per-project host-clone serialization (warren-232d).
 *
 * One warren process owns every project's host clone, and the dispatch
 * critical section — `refreshProjectClone` (`git checkout --force` /
 * `git reset --hard`) → `readProjectDefaults` (parses the working tree's
 * `.warren/config.yaml`) → the LocalProvider worktree materialization —
 * mutates that shared clone's HEAD and working tree. Two concurrent
 * dispatches against the same project with different base refs interleave
 * those swaps with each other's reads and corrupt the clone (a
 * half-checked-out tree, a defaults parse against the wrong ref, a
 * worktree cut mid-reset).
 *
 * This keyed mutex serializes that critical section per project id. Two
 * DIFFERENT projects dispatch fully in parallel; two dispatches on the SAME
 * project run back-to-back. In-process is sufficient: a single warren
 * process owns the clone (the K8s control-plane clone likewise lives in one
 * process), and there is no second writer to coordinate with.
 *
 * Reentrancy note: the lock is NOT reentrant. Nothing inside the dispatch
 * critical section may call `spawnRun` (or otherwise re-acquire) for the
 * same project — a nested acquisition would deadlock on the tail promise.
 * The plan-run dispatcher acquires once per child spawn and awaits it, so
 * it only ever holds one project's lock at a time.
 */

const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding project `projectId`'s clone lock. Calls for the
 * same project id execute strictly in acquisition order; calls for
 * different projects are independent. Failures propagate to the caller
 * but never break the chain for the next waiter.
 */
export async function withProjectCloneLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
	const prev = tails.get(projectId) ?? Promise.resolve();
	const release = prev.catch(() => {});
	const run = release.then(fn);
	// The tail swallows rejections so a failed dispatch can never wedge the
	// queue; the caller still observes the original error via `run`.
	const tail = run.catch(() => {});
	tails.set(projectId, tail);
	try {
		return await run;
	} finally {
		// Drop the map entry once this run is the settled tail, so the map
		// never grows unboundedly across a project's lifetime.
		void tail.then(() => {
			if (tails.get(projectId) === tail) tails.delete(projectId);
		});
	}
}
