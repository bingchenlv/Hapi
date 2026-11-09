type MetadataRecord = Record<string, unknown>

function titleText(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim() || undefined : undefined
}

function summaryText(metadata: MetadataRecord): string | undefined {
    const summary = metadata.summary
    return summary && typeof summary === 'object'
        ? titleText((summary as MetadataRecord).text)
        : undefined
}

export function syncCodexAutoName(next: MetadataRecord, current: MetadataRecord): MetadataRecord {
    const placeholder = typeof current.name === 'string' ? /^Codex-(\d+)$/.exec(current.name) : null
    const sequence = current.codexAutoNameSequence
        ?? (current.flavor === 'codex' && placeholder ? Number(placeholder[1]) : undefined)
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= 0) return next

    const result: MetadataRecord = { ...next, codexAutoNameSequence: sequence }
    const previousTitle = titleText(current.codexAutoNameTitle)
    const automatic = !current.name || current.name === previousTitle
        || (placeholder !== null && Number(placeholder[1]) === sequence)
    if (!automatic) return { ...result, name: current.name }

    const incomingSummary = summaryText(next)
    const incomingName = titleText(next.name)
    const changedSummary = incomingSummary && incomingSummary !== summaryText(current) ? incomingSummary : undefined
    const changedName = incomingName && incomingName !== current.name && !/^Codex-\d+$/.test(incomingName)
        ? incomingName : undefined
    const title = changedSummary ?? changedName ?? previousTitle ?? incomingSummary
    if (title) {
        result.name = title
        result.codexAutoNameTitle = title
    } else {
        result.name = current.name
    }
    return result
}
