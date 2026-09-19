import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_CATEGORIES } from "../src/components/EventModal";
import { EventCategory } from "../src/types";

test("Uscita didattica is a real event category", () => {
  const category: EventCategory = "uscita_didattica";
  assert.equal(category, "uscita_didattica");
  assert.deepEqual(EVENT_CATEGORIES.find(item => item.id === category), { id: category, label: "Uscita didattica" });
});
