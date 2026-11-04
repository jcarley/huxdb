import { acceptCompletion, autocompletion } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, keywordCompletionSource } from "@codemirror/lang-sql";
import { Compartment, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/** Holds completion, so a settings change applies without rebuilding the editor. Per editor state, so tabs can share it. */
export const completionCompartment = new Compartment();

/** Keywords and types. `lang-sql` already skips strings, comments and quoted
 * identifiers, and `u.|`, but not `u.sel|`, where a keyword can't be meant. */
export function keywordSource(upperCase: boolean): CompletionSource {
  const keywords = keywordCompletionSource(PostgreSQL, upperCase);
  return (context: CompletionContext) => {
    const word = context.matchBefore(/[\p{L}\p{N}_$]*/u);
    if (word && context.state.sliceDoc(word.from - 1, word.from) === ".") return null;
    return keywords(context);
  };
}

/** The completion list and its keys, or nothing when it's turned off. */
export function completionExtension({ completion, upperCaseKeywords }: { completion: boolean; upperCaseKeywords: boolean }): Extension {
  if (!completion) return [];
  return [
    // `override` also keeps out the source `sql()` adds through language data.
    autocompletion({ override: [keywordSource(upperCaseKeywords)] }),
    // Returns false with no list open, so Tab goes on to indent.
    Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
  ];
}
