/**
 * Authored entries for the fallback index.
 *
 * `scripts/build-fallback-index.mjs` generates `registry/v1/packages.json` from
 * the register, because everything the register knows already lives in D1 and a
 * second, hand-maintained copy of it rots. The standard library is the one
 * exception — it is not in the register, so there is nothing to generate it
 * from and it has to be written down somewhere. This is that somewhere, kept
 * out of the generator so that adding a module is a data change and not a code
 * change.
 *
 * ---------------------------------------------------------------------------
 * IT IS DELIBERATELY EMPTY. Read this before adding an entry.
 * ---------------------------------------------------------------------------
 *
 * The Fin standard library is not distributed through this registry, and `finn`
 * never fetches it. `finc`'s own interface contract settles how a standard
 * library module is found:
 *
 *   - the default library search path is `<directory of the finc executable>/../lib/std`,
 *     i.e. the standard library that shipped inside the compiler archive;
 *   - `finn` passes `--fin-libs`, and a named library path displaces the
 *     default entirely;
 *   - a module name becomes a path inside a search path — `m`, `m.fin`,
 *     `m/index.fin`, `m/m.fin`. Nothing resolves a standard library module over
 *     the network, from here or anywhere else.
 *
 * So a standard library module is not a package in this registry's sense: it is
 * not a claimable name, it points at no repository of its own, and it carries no
 * register state for a trust level to be derived from. Writing one in here
 * anyway would publish two claims we cannot stand behind — that the module is
 * resolved by fetching a repository, and that the registry has issued it a trust
 * level — and a `finn` that fell back to this index would then clone the whole
 * compiler repository into a project's module directory to satisfy `import
 * std.io`. That is worse than an absent entry: an absent name is `not_found`,
 * which is true, and it is what sends the user to the compiler they already have.
 *
 * Add entries here if — and only if — the owner decides that standard library
 * modules become registered packages with repositories of their own. Then each
 * entry states facts and nothing else:
 *
 *   {
 *     name: "somename",              // must satisfy the §2.1 name rule: lowercase
 *                                    //   letters and digits only, no hyphen
 *     repo_url: "https://github.com/OWNER/REPO",
 *     latest_version: null,          // null until a version record exists
 *     tag: null,                     //   "
 *     commit: null,                  //   "
 *     trust: "verified",             // never a guess; see the note below
 *     kind: "stdlib",
 *   }
 *
 * `trust` is read verbatim by the client and is the one field that must not be
 * filled in optimistically. The three levels mean what `src/lib/trust.ts`
 * derives them to mean, and a level in this file is an assertion made by
 * whoever edits this file rather than one derived from the register — which is
 * exactly why the client is required to read the level from the file rather than
 * promote anything it finds here.
 */

/** @type {{name: string, repo_url: string, latest_version: string|null, tag: string|null, commit: string|null, trust: "verified"|"trusted"|"recognized", kind: "stdlib"}[]} */
export const STDLIB_ENTRIES = [];
