import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session, SessionResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { SessionHybridModelToggle } from './SessionHybridModelToggle'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function fixture(options: { active?: boolean; supported?: boolean; deepseekHelper?: boolean; model?: string; routing?: NonNullable<Session['metadata']>['modelRouting'] } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const value = (id: string) => ({ session: { id, active: options.active ?? true,
        model: options.model, metadata: { modelRouting: options.routing, flavor: 'codex', ...(options.deepseekHelper ? { deepseekCollaboration: { mode: 'openai' } } : {}), capabilities: { deepseekCollaboration: options.deepseekHelper }, ...(options.supported === false ? {} : { hybridModel: { mode: 'hybrid' } }) }
    } as Session }) as SessionResponse
    for (const id of ['a', 'b']) client.setQueryData(queryKeys.session(id), value(id))
    let resolve!: (value: { mode: 'openai' | 'hybrid' }) => void
    let reject!: (error: Error) => void
    const request = new Promise<{ mode: 'openai' | 'hybrid' }>((yes, no) => { resolve = yes; reject = no })
    const setHybridModel = vi.fn(() => request)
    const setDeepSeekCollaboration = vi.fn(() => request)
    const api = { setHybridModel, setDeepSeekCollaboration } as unknown as ApiClient
    function Bound({ id }: { id: string }) {
        const { data } = useQuery({ queryKey: queryKeys.session(id), queryFn: () => value(id), enabled: false })
        return <SessionHybridModelToggle key={id} api={api} session={data!.session} />
    }
    const tree = (id: string) => <QueryClientProvider client={client}><Bound id={id} /></QueryClientProvider>
    const view = render(tree('a'))
    return { resolve, reject, setHybridModel, setDeepSeekCollaboration, client, navigate: (id: string) => view.rerender(tree(id)),
        mode: (id: string) => client.getQueryData<SessionResponse>(queryKeys.session(id))!.session.metadata!.hybridModel!.mode }
}

describe('session hybrid control', () => {
    it.each(['deepseek-flash', 'deepseek-v4-pro'])('pauses collaboration under %s without changing the preference', model => {
        const f = fixture({ model, deepseekHelper: true });
        expect(screen.queryByRole('switch')).toBeNull();
        expect(screen.getByText('hybrid.standalone')).toBeInTheDocument();
        expect(f.mode('a')).toBe('hybrid');
        expect(f.setHybridModel).not.toHaveBeenCalled();
    });
    it('labels both helpers only after the runtime advertises DeepSeek collaboration', () => {
        fixture({ model: 'gpt-test', deepseekHelper: true });
        expect(screen.getByRole('switch', { name: /MiniMax/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('switch', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'false');
    });
    it('changes DeepSeek alone and keeps a late confirmation scoped to the original session', async () => {
        const f = fixture({ model: 'gpt-test', deepseekHelper: true });
        fireEvent.click(screen.getByRole('switch', { name: /DeepSeek/ }));
        await waitFor(() => expect(f.setDeepSeekCollaboration).toHaveBeenCalledWith('a', 'hybrid'));
        expect(f.setHybridModel).not.toHaveBeenCalled();
        expect(screen.getByRole('switch', { name: /MiniMax/ })).not.toBeDisabled();
        f.navigate('b');
        await act(async () => f.resolve({ mode: 'hybrid' }));
        await waitFor(() => expect(f.client.getQueryData<SessionResponse>(queryKeys.session('a'))!.session.metadata!.deepseekCollaboration!.mode).toBe('hybrid'));
        expect(f.mode('a')).toBe('hybrid');
        expect(screen.getByRole('switch', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'false');
    });
    it('changing MiniMax does not enable DeepSeek', async () => {
        const f = fixture({ deepseekHelper: true });
        fireEvent.click(screen.getByRole('switch', { name: /MiniMax/ }));
        await waitFor(() => expect(f.setHybridModel).toHaveBeenCalledWith('a', 'openai'));
        await act(async () => f.resolve({ mode: 'openai' }));
        await waitFor(() => expect(f.mode('a')).toBe('openai'));
        expect(screen.getByRole('switch', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'false');
        expect(f.setDeepSeekCollaboration).not.toHaveBeenCalled();
    });
    it('does not optimistically enable DeepSeek after failed confirmation', async () => {
        const f = fixture({ deepseekHelper: true });
        fireEvent.click(screen.getByRole('switch', { name: /DeepSeek/ }));
        await waitFor(() => expect(f.setDeepSeekCollaboration).toHaveBeenCalledTimes(1));
        await act(async () => f.reject(new Error('DeepSeek setting unknown')));
        expect(await screen.findByRole('alert')).toHaveTextContent('DeepSeek setting unknown');
        expect(screen.getByRole('switch', { name: /DeepSeek/ })).toHaveAttribute('aria-checked', 'false');
        expect(f.setHybridModel).not.toHaveBeenCalled();
    });
    it.each(['hybrid', 'openai'] as const)('keeps %s preference without an active helper switch under MiniMax', async mode => {
        const f = fixture({ model: 'MiniMax-M3.1-Flash-Preview' });
        await act(async () => { f.client.setQueryData<SessionResponse>(queryKeys.session('a'), old => ({ ...old!, session: { ...old!.session,
            metadata: { ...old!.session.metadata!, hybridModel: { mode } } } })); });
        expect(screen.queryByRole('switch')).toBeNull();
        expect(screen.getByText('hybrid.standalone')).toBeInTheDocument();
        expect(f.mode('a')).toBe(mode);
        expect(f.setHybridModel).not.toHaveBeenCalled();
        await act(async () => { f.client.setQueryData<SessionResponse>(queryKeys.session('a'), old => ({ ...old!, session: { ...old!.session, model: 'gpt-test' } })); });
        await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', String(mode === 'hybrid')));
    });
    it.each(['switching', 'failed'] as const)('blocks the switch when provider status is %s', status => {
        const f = fixture({ routing: { provider: 'openai', status, reason: 'manual', updatedAt: 1 } });
        expect(screen.queryByRole('switch')).toBeNull();
        expect(screen.getByText('hybrid.routePending')).toBeInTheDocument();
        expect(f.setHybridModel).not.toHaveBeenCalled();
    });
    it.each(['minimax', 'deepseek'] as const)('recognizes the confirmed %s route before the model label refreshes', provider => {
        fixture({ routing: { provider, status: 'active', reason: 'manual', updatedAt: 1 } });
        expect(screen.queryByRole('switch')).toBeNull();
        expect(screen.getByText('hybrid.standalone')).toBeInTheDocument();
    });

    it('waits for confirmation and updates only the requested session', async () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(f.setHybridModel).toHaveBeenCalledWith('a', 'openai'))
        expect(screen.getByRole('switch')).toBeDisabled()
        expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
        await act(async () => f.resolve({ mode: 'openai' }))
        await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
        expect(f.mode('a')).toBe('openai')
        expect(f.mode('b')).toBe('hybrid')
    })
    it('preserves confirmed mode and displays API failure', async () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(f.setHybridModel).toHaveBeenCalledTimes(1))
        await act(async () => f.reject(new Error('runtime disconnected')))
        expect(await screen.findByRole('alert')).toHaveTextContent('runtime disconnected')
        expect(f.mode('a')).toBe('hybrid')
        expect(screen.getByRole('switch')).not.toBeDisabled()
    })
    it('rejects an unconfirmed mode', async () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(f.setHybridModel).toHaveBeenCalledTimes(1))
        await act(async () => f.resolve({ mode: 'hybrid' }))
        expect(await screen.findByRole('alert')).toHaveTextContent('hybrid.unconfirmed')
        expect(f.mode('a')).toBe('hybrid')
    })
    it('keeps a late response bound to the original session after navigation', async () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('switch'))
        await waitFor(() => expect(f.setHybridModel).toHaveBeenCalledTimes(1))
        f.navigate('b')
        await act(async () => f.resolve({ mode: 'openai' }))
        await waitFor(() => expect(f.mode('a')).toBe('openai'))
        expect(f.mode('b')).toBe('hybrid')
        expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    })
    it('does not call the API for an inactive session', () => {
        const f = fixture({ active: false })
        fireEvent.click(screen.getByRole('switch'))
        expect(f.setHybridModel).not.toHaveBeenCalled()
    })
    it('shows availability information for older runtimes', () => {
        const f = fixture({ supported: false })
        expect(screen.queryByRole('switch')).toBeNull()
        expect(screen.getByText('hybrid.unavailable')).toBeInTheDocument()
        expect(f.setHybridModel).not.toHaveBeenCalled()
    })
})
