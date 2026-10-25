// The card bodies' modules, loaded ahead (tests/editor-card-preload.test.mjs). React.lazy only
// skips the suspension when the import it is handed has already settled; a module promise never
// has, even when the module is loaded, so a loaded module is handed over as a thenable that calls
// back at once. A body still loading when its card opens would show its fallback and grow under
// the pointer when React reveals it.

/** One registry of loaded card modules: `preload(cards)` and `importer(card)` for React.lazy. */
export function cardModules() {
  const loaded = new Map();
  const remember = (card) => card.load().then((module) => {
    loaded.set(card.file, module);
    return module;
  });
  return {
    /** Loads every card's module; a failure is left for the card's own import to meet. */
    preload(cards) {
      return Promise.all(cards.map((card) => (loaded.has(card.file) ? null : remember(card).catch(() => null))));
    },
    /** The import React.lazy calls: settled at once when the module is loaded. */
    importer(card) {
      return () => {
        const module = loaded.get(card.file);
        return module ? { then: (resolve) => resolve(module) } : remember(card);
      };
    },
  };
}
