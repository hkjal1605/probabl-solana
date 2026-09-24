/** An epoch, not just equality: A → B → A must invalidate work started in A. */
export function createActionScope(initial: string) {
  let context = initial,
    revision = 0,
    alive = true,
    locked = false;
  return {
    update(next: string) {
      if (next !== context) {
        context = next;
        revision++;
      }
    },
    mount() {
      alive = true;
    },
    dispose() {
      alive = false;
      revision++;
    },
    begin() {
      if (locked || !alive) return null;
      locked = true;
      const expected = revision;
      return {
        assertCurrent() {
          if (!alive || revision !== expected)
            throw new Error("Wallet or action details changed. Review the action again.");
        },
        finish() {
          locked = false;
        },
      };
    },
  };
}
