// Proxima — Memory Store.
// Manages in-memory interaction history and entry evictions.

import { randomUUID } from 'crypto';

export class MemoryHistoryManager {
  constructor() {
    this.memoryStore = new Map();
    this.maxEntries = 1000;
  }

  async addHistory(memoryId, previousValue, newValue, action, createdAt, updatedAt, isDeleted = 0) {
    const historyEntry = {
      id: randomUUID(),
      memory_id: memoryId,
      previous_value: previousValue,
      new_value: newValue,
      action: action,
      created_at: createdAt || new Date().toISOString(),
      updated_at: updatedAt || null,
      is_deleted: isDeleted,
    };
    this.memoryStore.set(historyEntry.id, historyEntry);


    if (this.memoryStore.size > this.maxEntries) {
      const iterator = this.memoryStore.keys();
      while (this.memoryStore.size > this.maxEntries) {
        const oldestKey = iterator.next().value;
        if (oldestKey === undefined) break;
        this.memoryStore.delete(oldestKey);
      }
    }
  }

  async getHistory(memoryId) {
    return Array.from(this.memoryStore.values())
      .filter((entry) => entry.memory_id === memoryId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 100);
  }

  async reset() {
    this.memoryStore.clear();
  }


  close() {
    return;
  }
}

export default MemoryHistoryManager;
