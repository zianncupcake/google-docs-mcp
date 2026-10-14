// Just enough of a Workers KV namespace for the tests: get, put, delete, list. putOptions keeps
// the options of each key's last put, so a test can see its expiry.
export class MemoryKV {
  #entries = new Map()
  putOptions = new Map()

  async get(key, options) {
    const value = this.#entries.get(key)
    if (value === undefined) return null
    const type = typeof options === 'string' ? options : options?.type
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key, value, options) {
    this.#entries.set(key, String(value))
    this.putOptions.set(key, options)
  }

  async delete(key) {
    this.#entries.delete(key)
  }

  async list({ prefix = '' } = {}) {
    const keys = [...this.#entries.keys()].filter(name => name.startsWith(prefix)).map(name => ({ name }))
    return { keys, list_complete: true }
  }
}
