const config = require('./config');
const CacheManager = require('./cache-manager')(config);
const EPGManager = require('./epg-manager');
const StreamProxyManager = require('./stream-proxy-manager')(config);
const ResolverStreamManager = require('./resolver-stream-manager')(config);
const PythonRunner = require('./python-runner'); // OTTIMIZZAZIONE: Spostato qui

// --- NUOVA BOMBA #1: Cache per il Resolver ---
const resolvedStreamCache = new Map();

function getResolvedCache(id) {
    const cached = resolvedStreamCache.get(id);
    if (cached && cached.expires > Date.now()) {
        console.log(`[Cache Resolver] Trovato stream valido per ${id}`);
        return cached.data;
    }
    return null;
}

function setResolvedCache(id, data, ttlMs = 5 * 60 * 1000) { // Cache di 5 minuti
    console.log(`[Cache Resolver] Salvataggio stream per ${id}`);
    const cacheItem = {
        data: data,
        expires: Date.now() + ttlMs
    };
    resolvedStreamCache.set(id, cacheItem);
}
// --- FINE BOMBA #1 ---


function getLanguageFromConfig(userConfig) {
    return userConfig.language || config.defaultLanguage || 'Italiana';
}

function normalizeId(id) {
    return id?.toLowerCase().replace(/[^\w.]/g, '').trim() || '';
}

function cleanNameForImage(name) {
    // (Tua funzione, lasciata invariata, è ottima)
    let cleaned = name.replace(/\d{2}\/\d{2}\/\d{2}\s*-\s*\d{2}:\d{2}\s*\(CET\)/g, '').trim();
    cleaned = cleaned.replace(/^20\d{2}\s+/, '');
    cleaned = cleaned.replace(/[^a-zA-Z0-9\s-]/g, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    let parts = cleaned.split(' - ');
    if (parts.length > 1) {
        cleaned = parts[0].trim();
    }
    if (cleaned.length > 30) {
        let words = cleaned.split(' ');
        let result = '';
        for (let word of words) {
            if ((result + ' ' + word).length <= 27) {
                result += (result ? ' ' : '') + word;
            } else {
                break;
            }
        }
        cleaned = result + '...';
    }
    return cleaned || 'No Name';
}

async function catalogHandler({ type, id, extra, config: userConfig }) {
    try {
        if (!userConfig.m3u) {
            console.log('[Handlers] URL M3U mancante nella configurazione');
            return { metas: [], genres: [] };
        }

        await CacheManager.updateConfig(userConfig);

        if (userConfig.epg_enabled === 'true') {
            const epgToUse = userConfig.epg ||
                (CacheManager.cache.epgUrls && 
                CacheManager.cache.epgUrls.length > 0
                    ? CacheManager.cache.epgUrls.join(',')
                    : null);
                    
            if (epgToUse) {
                await EPGManager.initializeEPG(epgToUse);
            }
        }

        let { search, genre, skip = 0 } = extra || {};
        
        if (genre && genre.includes('&skip')) {
            const parts = genre.split('&skip');
            genre = parts[0];
            if (parts[1] && parts[1].startsWith('=')) {
                skip = parseInt(parts[1].substring(1)) || 0;
            }
        }

        if (search) {
            CacheManager.setLastFilter('search', search);
        } else if (genre) {
            CacheManager.setLastFilter('genre', genre);
        } else if (!skip) {
            CacheManager.clearLastFilter();
        }

        skip = parseInt(skip) || 0;
        const ITEMS_PER_PAGE = 100;
        
        // --- NUOVA BOMBA #3: Catalogo "In Onda Ora" ---
        // (Assumendo che il catalogo sia definito in manifest.json con id 'omg_tv_now_playing')
        if (id === 'omg_tv_now_playing') {
            console.log('[Handlers] Richiesta Catalogo Dinamico "In Onda Ora"');
            let allChannels = CacheManager.getCachedData().channels;
            let nowPlayingMetas = [];

            for (const channel of allChannels) {
                const program = EPGManager.getCurrentProgram(normalizeId(channel.streamInfo?.tvg?.id));
                if (program) {
                    const meta = createMeta(channel, userConfig); // Usa la nuova funzione helper
                    meta.name = `[IN ONDA] ${channel.name}`;
                    meta.poster = meta.logo; // Usa il logo come poster
                    meta.releaseInfo = `${program.start} - ${program.stop}`;
                    meta.description = `${program.title}\n${program.description || ''}`;
                    nowPlayingMetas.push(meta);
                }
            }
            console.log(`[Handlers] Trovati ${nowPlayingMetas.length} programmi "In Onda Ora"`);
            return { metas: nowPlayingMetas }; // Ritorna senza paginazione per ora
        }
        // --- FINE BOMBA #3 ---

        // Flusso normale per il catalogo principale
        let filteredChannels = CacheManager.getFilteredChannels();
        const cachedData = CacheManager.getCachedData();

        const paginatedChannels = filteredChannels.slice(skip, skip + ITEMS_PER_PAGE);
        const metas = paginatedChannels.map(channel => createMeta(channel, userConfig));

        // --- NUOVA BOMBA #2: Canale "Rigenera" Visibile ---
        if (skip === 0 && !search && !genre && userConfig.python_script_url) {
            metas.unshift({
                id: 'tv|rigeneraplaylistpython',
                type: 'tv',
                name: '🔄 RIGENERA PLAYLIST PYTHON',
                description: 'Clicca "Play" per eseguire lo script Python e rigenerare la playlist M3U.\n\nNOTA: Dopo aver cliccato, torna indietro e ricarica il catalogo.',
                poster: 'https://dummyimage.com/500x500/8A5AAB/ffffff.jpg&text=ESEGUI',
                logo: 'https://dummyimage.com/500x500/8A5AAB/ffffff.jpg&text=ESEGUI',
                background: 'https://dummyimage.com/500x500/8A5AAB/ffffff.jpg&text=ESEGUI',
                posterShape: 'square',
                releaseInfo: 'AZIONE'
            });
        }
        // --- FINE BOMBA #2 ---

        return {
            metas,
            genres: cachedData.genres
        };

    } catch (error) {
        console.error('[Handlers] Errore nella gestione del catalogo:', error);
        return { metas: [], genres: [] };
    }
}

// --- NUOVA FUNZIONE HELPER ---
// Ho estratto la logica di creazione META per riutilizzarla (BOMBA #3)
function createMeta(channel, userConfig) {
    const displayName = cleanNameForImage(channel.name);
    const encodedName = encodeURIComponent(displayName).replace(/%20/g, '+');
    const fallbackLogo = `https://dummyimage.com/500x500/590b8a/ffffff.jpg&text=${encodedName}`;
    const language = getLanguageFromConfig(userConfig);
    const languageAbbr = language.substring(0, 3).toUpperCase();
    
    const meta = {
        id: channel.id,
        type: 'tv',
        name: `${channel.name} [${languageAbbr}]`,
        poster: channel.poster || fallbackLogo,
        background: channel.background || fallbackLogo,
        logo: channel.logo || fallbackLogo,
        description: channel.description || `Canale: ${channel.name} - ID: ${channel.streamInfo?.tvg?.id}`,
        genre: channel.genre,
        posterShape: channel.posterShape || 'square',
        releaseInfo: 'LIVE',
        behaviorHints: {
            isLive: true,
            ...channel.behaviorHints
        },
        streamInfo: channel.streamInfo
    };

    if (channel.streamInfo?.tvg?.chno) {
        meta.name = `${channel.streamInfo.tvg.chno}. ${channel.name} [${languageAbbr}]`;
    }

    if ((!meta.poster || !meta.background || !meta.logo) && channel.streamInfo?.tvg?.id) {
        const epgIcon = EPGManager.getChannelIcon(channel.streamInfo.tvg.id);
        if (epgIcon) {
            meta.poster = meta.poster || epgIcon;
            meta.background = meta.background || epgIcon;
            meta.logo = meta.logo || epgIcon;
        }
    }

    return enrichWithEPG(meta, channel.streamInfo?.tvg?.id, userConfig);
}
// --- FINE FUNZIONE HELPER ---


function enrichWithEPG(meta, channelId, userConfig) {
    // (Tua funzione, lasciata invariata)
    if (!userConfig.epg_enabled || !channelId) {
        meta.description = `Canale live: ${meta.name}`;
        meta.releaseInfo = 'LIVE';
        return meta;
    }

    const currentProgram = EPGManager.getCurrentProgram(normalizeId(channelId));
    const upcomingPrograms = EPGManager.getUpcomingPrograms(normalizeId(channelId));

    if (currentProgram) {
        meta.description = `IN ONDA ORA:\n${currentProgram.title}`;
        if (currentProgram.description) {
            meta.description += `\n${currentProgram.description}`;
        }
        meta.description += `\nOrario: ${currentProgram.start} - ${currentProgram.stop}`;
        if (currentProgram.category) {
            meta.description += `\nCategoria: ${currentProgram.category}`;
        }
        if (upcomingPrograms && upcomingPrograms.length > 0) {
            meta.description += '\n\nPROSSIMI PROGRAMMI:';
            upcomingPrograms.forEach(program => {
                meta.description += `\n${program.start} - ${program.title}`;
            });
        }
        meta.releaseInfo = `In onda: ${currentProgram.title}`;
    }
    return meta;
}

async function streamHandler({ id, config: userConfig }) {
    try {
        if (!userConfig.m3u) {
            console.log('M3U URL mancante');
            return { streams: [] };
        }

        await CacheManager.updateConfig(userConfig);

        const channelId = id.split('|')[1];
        
        // Gestione canale speciale (invariato, è già una bomba)
        if (channelId === 'rigeneraplaylistpython') {
            console.log('\n=== Richiesta rigenerazione playlist Python ===');
            const result = await PythonRunner.executeScript();
            
            if (result) {
                console.log('✓ Script Python eseguito con successo');
                console.log('Ricostruzione cache con il nuovo file generato...');
                await CacheManager.rebuildCache(userConfig.m3u, userConfig);
                
                return { 
                    streams: [{
                        name: 'Completato',
                        title: '✅ Playlist rigenerata con successo!\n Riavvia stremio o torna indietro.',
                        url: 'https://static.vecteezy.com/system/resources/previews/001/803/236/mp4/no-signal-bad-tv-free-video.mp4',
                        behaviorHints: { notWebReady: false, bingeGroup: "tv" }
                    }]
                };
            } else {
                console.log('❌ Errore nell\'esecuzione dello script Python');
                return { 
                    streams: [{
                        name: 'Errore',
                        title: `❌ Errore: ${PythonRunner.lastError || 'Errore sconosciuto'}`,
                        url: 'https://static.vecteezy.com/system/resources/previews/001/803/236/mp4/no-signal-bad-tv-free-video.mp4',
                        behaviorHints: { notWebReady: false, bingeGroup: "tv" }
                    }]
                };
            }
        }
        
        const channel = CacheManager.getChannel(channelId);

        if (!channel) {
            console.log('Canale non trovato:', channelId);
            return { streams: [] };
        }

        let streams = [];
        let originalStreamDetails = [];

        if (channel.streamInfo.urls) {
            for (const stream of channel.streamInfo.urls) {
                const headers = stream.headers || {};
                if (!headers['User-Agent']) {
                    headers['User-Agent'] = config.defaultUserAgent;
                }
                
                originalStreamDetails.push({
                    name: channel.name,
                    originalName: stream.name,
                    url: stream.url,
                    headers: headers
                });
            }
        }

        if (userConfig.resolver_enabled === 'true' && userConfig.resolver_script) {
            
            // --- MODIFICA BOMBA #1: Controllo Cache Resolver ---
            let cachedStreams = getResolvedCache(channel.id);
            if (cachedStreams) {
                console.log(`\n=== Utilizzo Resolver CACHE per ${channel.name} ===`);
                streams = cachedStreams; // Usa la cache!
            } else {
                console.log(`\n=== Utilizzo Resolver per ${channel.name} ===`);
                try {
                    const streamDetails = {
                        name: channel.name,
                        originalName: channel.name,
                        streamInfo: { urls: channel.streamInfo.urls }
                    };
                    
                    const resolvedStreams = await ResolverStreamManager.getResolvedStreams(streamDetails, userConfig);
                    
                    if (resolvedStreams && resolvedStreams.length > 0) {
                        console.log(`✓ Ottenuti ${resolvedStreams.length} flussi risolti`);
                        
                        if (userConfig.force_proxy === 'true') {
                            if (userConfig.proxy && userConfig.proxy_pwd) {
                                console.log('⚙️ Applicazione proxy ai flussi risolti (modalità forzata)...');
                                for (const resolvedStream of resolvedStreams) {
                                    const proxied = await StreamProxyManager.getProxyStreams({...resolvedStream, originalName: resolvedStream.title}, userConfig);
                                    streams.push(...proxied);
                                }
                            } else {
                                console.log('⚠️ Proxy forzato ma non configurato, uso flussi risolti originali');
                                streams = resolvedStreams;
                            }
                        } else {
                            streams = resolvedStreams; // Aggiungi flussi risolti
                            if (userConfig.proxy && userConfig.proxy_pwd) {
                                console.log('⚙️ Aggiunta dei flussi proxy ai flussi risolti...');
                                for (const resolvedStream of resolvedStreams) {
                                     const proxied = await StreamProxyManager.getProxyStreams({...resolvedStream, originalName: resolvedStream.title}, userConfig);
                                    streams.push(...proxied);
                                }
                            }
                        }
                        
                        // --- MODIFICA BOMBA #1: Salva in Cache ---
                        setResolvedCache(channel.id, streams); // Salva i flussi trovati

                    } else {
                        console.log('⚠️ Nessun flusso risolto disponibile, utilizzo flussi standard');
                        streams = await processOriginalStreams(originalStreamDetails, channel, userConfig);
                    }
                } catch (resolverError) {
                    console.error('❌ Errore durante la risoluzione dei flussi:', resolverError);
                    streams = await processOriginalStreams(originalStreamDetails, channel, userConfig);
                }
            }
            // --- FINE MODIFICA BOMBA #1 ---

        } else {
            streams = await processOriginalStreams(originalStreamDetails, channel, userConfig);
        }

        // Aggiungi i metadati (invariato)
        const displayName = cleanNameForImage(channel.name);
        const encodedName = encodeURIComponent(displayName).replace(/%20/g, '+');
        const fallbackLogo = `https://dummyimage.com/500x500/590b8a/ffffff.jpg&text=${encodedName}`;

        const meta = {
            id: channel.id,
            type: 'tv',
            name: channel.name,
            poster: channel.poster || fallbackLogo,
            background: channel.background || fallbackLogo,
            logo: channel.logo || fallbackLogo,
            description: channel.description || `ID Canale: ${channel.streamInfo?.tvg?.id}`,
            genre: channel.genre,
            posterShape: channel.posterShape || 'square',
            releaseInfo: 'LIVE',
            behaviorHints: { isLive: true, ...channel.behaviorHints },
            streamInfo: channel.streamInfo
        };

        if ((!meta.poster || !meta.background || !meta.logo) && channel.streamInfo?.tvg?.id) {
            const epgIcon = EPGManager.getChannelIcon(channel.streamInfo.tvg.id);
            if (epgIcon) {
                meta.poster = meta.poster || epgIcon;
                meta.background = meta.background || epgIcon;
                meta.logo = meta.logo || epgIcon;
            }
        }

        streams.forEach(stream => {
            stream.meta = meta;
        });

        return { streams };
    } catch (error) {
        console.error('Errore stream handler:', error);
        return { streams: [] };
    }
}

async function processOriginalStreams(originalStreamDetails, channel, userConfig) {
    // (Tua funzione, lasciata invariata)
    let streams = [];
    
    if (userConfig.force_proxy === 'true') {
        if (userConfig.proxy && userConfig.proxy_pwd) {
            for (const streamDetails of originalStreamDetails) {
                const proxyStreams = await StreamProxyManager.getProxyStreams(streamDetails, userConfig);
                streams.push(...proxyStreams);
            }
        }
    } else {
        for (const streamDetails of originalStreamDetails) {
            const language = getLanguageFromConfig(userConfig);
            const streamMeta = {
                name: streamDetails.name,
                title: `📺 ${streamDetails.originalName || streamDetails.name} [${language.substring(0, 3).toUpperCase()}]`,
                url: streamDetails.url,
                headers: streamDetails.headers,
                language: language,
                behaviorHints: {
                    notWebReady: false,
                    bingeGroup: "tv"
                }
            };
            streams.push(streamMeta);

            if (userConfig.proxy && userConfig.proxy_pwd) {
                const proxyStreams = await StreamProxyManager.getProxyStreams(streamDetails, userConfig);
                streams.push(...proxyStreams);
            }
        }
    }
    
    return streams;
}

module.exports = {
    catalogHandler,
    streamHandler,
    processOriginalStreams
};
