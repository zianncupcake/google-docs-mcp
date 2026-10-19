// Just enough of a Durable Object's storage for the tests: get, put, delete, list and the alarm.
export class MemoryStorage {
  #entries = new Map()
  #alarm = null

  async get(key) { return this.#entries.get(key) }
  async put(key, value) { this.#entries.set(key, value) }
  async delete(key) { return this.#entries.delete(key) }
  async list() { return new Map(this.#entries) }
  async getAlarm() { return this.#alarm }
  async setAlarm(time) { this.#alarm = time }
}
