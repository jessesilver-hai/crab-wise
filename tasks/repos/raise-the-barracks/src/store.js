export function createStore(seedItems = []) {
  const items = new Map();
  const reservations = [];
  let nextItemId = 1;
  let nextReservationId = 1;

  const store = {
    addItem({ name, stock }) {
      const item = { id: String(nextItemId++), name, stock };
      items.set(item.id, item);
      return item;
    },

    listItems() {
      return [...items.values()];
    },

    getItem(id) {
      return items.get(id) ?? null;
    },

    listReservations() {
      return [...reservations];
    },

    // Low-level: records the reservation without checking stock. Callers are
    // responsible for validating availability and adjusting item stock.
    addReservation({ itemId, quantity }) {
      const reservation = { id: String(nextReservationId++), itemId, quantity };
      reservations.push(reservation);
      return reservation;
    },
  };

  for (const seed of seedItems) {
    store.addItem(seed);
  }

  return store;
}
