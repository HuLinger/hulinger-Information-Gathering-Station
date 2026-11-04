export type Kind = 'model' | 'project' | 'tool';
export type EventStatus = 'active' | 'review' | 'excluded' | 'trash' | 'merged';
export interface Personal { favorite: boolean; later: boolean; read: boolean; archived: boolean; note: string }
export interface HubEvent {
  id: string; title: string; summary: string; kind: Kind; url: string;
  published_at: string | null; published_precision: string; discovered_at: string; updated_at: string;
  entity_id: string | null; source_name: string; review_reason: string | null;
  status: EventStatus; deleted_at: string | null; revision: number; manual: boolean;
  personal: Personal; overrides: Record<string, unknown>; tags: string[]; originals: Record<string, unknown>;
}
export interface Entity { id: string; kind: Kind; name: string; url: string; data: Record<string, unknown>; followed: boolean; revision: number }
export interface Source { id: string; name: string; kind: string; url: string; enabled: boolean; interval_minutes: number; config: Record<string, unknown>; last_attempt: string | null; last_success: string | null; next_run: string | null; error: string | null; coverage: string | null }
export interface SyncRun { id: string; source_id: string; status: string; started_at: string; finished_at: string | null; added: number; updated: number; skipped: number; error: string | null; coverage: string | null }
export interface Revision { id: string; event_id: string; created_at: string; action: string; before_data: HubEvent | null; after_data: HubEvent | null }
export interface HubData { events: HubEvent[]; total: number; entities: Entity[]; sources: Source[]; runs: SyncRun[]; later: HubEvent[]; page: number }

// GET /api/hub?view=feed|models|projects|mine|sources|search|settings
// &section=favorite|later|archived|review|excluded|trash &q=&kind=&source=&tag=&unread=1&followed=1&page=1
// Returns HubData. GET /api/hub?id=... returns {event, records, history}.
// POST /api/hub: {action, ...} -> {ok:true,...}; failures {error,code}, HTTP 409 on edit conflicts.
// action create: {title,summary,url,kind,published_at?,entity_id?,tags?,note?}
// action update: {id,revision,patch:{title?,summary?,kind?,entity_id?,tags?,personal?:Partial<Personal>},reset?:string[]}
// action status: {ids:string[],status:'active'|'review'|'excluded'|'trash'|'delete'}
// action batch: {ids,personal:Partial<Personal>}; action follow: {id,followed}
// action source: {id,enabled?,config?}; action sync: {id}
// action mergePreview/merge: {ids}; merge additionally {revisions:Record<string,number>,title,summary,personal,tags}
// action split: {id,revision,groups:{recordIds:string[],title:string,personal:Personal,tags:string[]}[]}
// action undoMerge: {id,revision}; action restoreRevision: {id,revision,historyId}
// GET /api/hub/export -> authenticated versioned JSON with all content, no credentials.
