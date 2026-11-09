import { describe, expect, it } from 'vitest';
import { withSessionProjectContext } from './project';

const project = { id: 'FF', name: '家庭记账', directory: '/work/family-finance', controllerSessionId: 'controller', role: 'research' as const };

describe('project startup context', () => {
    it('leaves unbound custom instructions untouched', () => {
        expect(withSessionProjectContext(undefined, undefined)).toBeUndefined();
        expect(withSessionProjectContext('Custom instructions', undefined)).toBe('Custom instructions');
    });
    it('adds the shared entry and preserves custom instructions without changing the binding', () => {
        const snapshot = { ...project };
        const text = withSessionProjectContext('Custom instructions', project)!;
        expect(text).toContain('Custom instructions');
        expect(text).toContain('/work/family-finance/AGENTS.md');
        expect(text).toContain('controller');
        expect(text).toContain('own HAPI session identity');
        expect(text).toContain('does not grant or remove platform permissions');
        expect(withSessionProjectContext(text, project)).toBe(text);
        expect(project).toEqual(snapshot);
    });
    it('encodes angle brackets in metadata separately from instructions', () => {
        const text = withSessionProjectContext(undefined, { ...project, name: '<project>' })!;
        expect(text).not.toContain('<project>');
        expect(text).toContain('\\u003cproject>');
    });
});
