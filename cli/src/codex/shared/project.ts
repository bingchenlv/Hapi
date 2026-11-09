import { join } from 'node:path';
import type { SessionProject } from '@hapi/protocol';

/** Project context is a business instruction, never a sandbox or identity grant. */
export function withSessionProjectContext(existing: string | undefined, project: SessionProject | undefined): string | undefined {
    if (!project) return existing;
    const context = [
        '[HAPI project context]',
        JSON.stringify(project).replace(/</g, '\\u003c'),
        'Read the project instructions at ' + join(project.directory, 'AGENTS.md') + ' and the relevant shared project documents before project work.',
        'The controllerSessionId and createdFromSessionId are references. Use your own HAPI session identity for tools and messages.',
        'Research sessions produce drafts and progress reports. Only modify application code within an explicitly assigned development task. The controller reviews and maintains formal outputs.',
        'Keep the user-selected model, approval, sandbox and per-session hybrid settings. A project role does not grant or remove platform permissions.',
        'This is a fresh conversation; retrieve project state from its instructions and shared documents rather than claiming to remember other sessions.',
        '[/HAPI project context]'
    ].join('\n');
    return existing?.includes(context) ? existing : [existing, context].filter(Boolean).join('\n\n');
}
