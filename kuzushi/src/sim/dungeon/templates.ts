import type { ZoneId } from "../zones.ts"
import type { RoomTemplate, TemplateRole } from "./plan.ts"
import { COURTYARD_ROOMS } from "./rooms/courtyard.ts"
import { SPIRAL_ROOMS } from "./rooms/spiral.ts"
import { VOID_ROOMS } from "./rooms/void.ts"

/** Every room template, named "zone.name": seven per zone, one file per zone in ./rooms/. */
export const TEMPLATES = { ...COURTYARD_ROOMS, ...SPIRAL_ROOMS, ...VOID_ROOMS } as const satisfies Record<string, RoomTemplate>

export type TemplateId = keyof typeof TEMPLATES

export const isTemplateId = (value: unknown): value is TemplateId => typeof value === "string" && Object.hasOwn(TEMPLATES, value)

export const templateIds: ReadonlyArray<TemplateId> = Object.keys(TEMPLATES).filter(isTemplateId)

export const templateOf = (id: TemplateId): RoomTemplate => TEMPLATES[id]

/** A zone's templates for one role, in the order they are listed. */
export const templatesFor = (zone: ZoneId, role: TemplateRole): ReadonlyArray<TemplateId> =>
  templateIds.filter((id) => TEMPLATES[id].zone === zone && TEMPLATES[id].role === role)
