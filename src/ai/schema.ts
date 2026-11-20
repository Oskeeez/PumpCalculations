/** Minimal JSON-Schema validator for tool input (type, enum, range, required, additionalProperties:false). Returns a readable error or undefined. */
export interface Schema {
  type?: string | string[];
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  maxItems?: number;
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function validate(schema: Schema, value: unknown, path = 'input'): string | undefined {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'integer' && t === 'number' && Number.isInteger(value)));
    if (!ok) return `${path} must be ${types.join(' or ')}, got ${t}.`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path} must be a finite number.`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be ≥ ${schema.minimum}, got ${value}.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be ≤ ${schema.maximum}, got ${value}.`;
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.trim().length < schema.minLength) return `${path} must not be empty.`;
  if (schema.enum && !schema.enum.includes(value as string | number)) return `${path} must be one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}.`;
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items (max ${schema.maxItems}).`;
    if (schema.items) for (let i = 0; i < value.length; i++) { const e = validate(schema.items, value[i], `${path}[${i}]`); if (e) return e; }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (o[r] === undefined) return `${path}.${r} is required.`;
    for (const [k, v] of Object.entries(o)) {
      const s = schema.properties[k];
      if (!s) { if (schema.additionalProperties === false) return `${path}.${k} is not a known parameter. Allowed: ${Object.keys(schema.properties).join(', ')}.`; continue; }
      const e = validate(s, v, `${path}.${k}`);
      if (e) return e;
    }
  }
  return undefined;
}
