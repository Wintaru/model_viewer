/**
 * A lazy `import()` cache, keyed by a caller-chosen string type and
 * returning a caller-chosen module type — both generics, so this file
 * never needs to import `Common` or any other layer to be fully typed.
 * `.dependency-cruiser.js`'s `no-utility-outbound` rule forbids Utility
 * from importing anything, `Common` included, and `tsPreCompilationDeps`
 * makes that bite even on a type-only import — see DECISIONS.md's
 * slice-2 planning entry. The concrete types (e.g. keyed by `FormatId`)
 * are supplied where this is instantiated, in `ModelLoadManager`.
 *
 * Named and placed by ARCHITECTURE.md sections 2 and 3: the Utility a
 * Manager calls to turn a sniffed format into that format's decoder
 * module, one dynamic `import()` per format, so a bundler splits each
 * decoder into its own chunk (SPEC.md D10).
 */
export class ModuleRegistry<TKey extends string, TModule> {
  private readonly cache = new Map<TKey, Promise<TModule>>();

  constructor(
    private readonly loaders: Readonly<Record<TKey, () => Promise<TModule>>>,
  ) {}

  /**
   * Resolves the module for `key`, importing it at most once. A second
   * call for the same key — including one made before the first import
   * settles — returns that same in-flight or settled promise, so two
   * callers racing for a chunk a bundler hasn't split yet don't trigger
   * two fetches of it.
   *
   * A rejected import is not cached past the call that saw it fail: the
   * failure here is a real one (a chunk fetched over the network genuinely
   * can drop), and permanently poisoning the registry over one transient
   * failure would mean every later attempt to open a file of that format
   * fails without ever touching the network again.
   */
  get(key: TKey): Promise<TModule> {
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const promise = this.loaders[key]().catch((error: unknown) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, promise);
    return promise;
  }
}
