const EventEmitter = require('events');
const PlaylistTransformer = require('./playlist-transformer');

class CacheManager extends EventEmitter {
    constructor(config) {
        super();
        this.transformer = new PlaylistTransformer();
        this.config = config;
        this.cache = null;
        this.pollingInterval = null;
        this.lastFilter = null;
        this.initCache();
        this.startPolling();
    }

    initCache() {
        this.cache = {
            stremioData: null,
            lastUpdated: null,
            updateInProgress: false,
            m3uUrl: null,
            epgUrls: []
        };
        this.lastFilter = null;
    }

    async updateConfig(newConfig) {
        // Verifica separatamente i cambiamenti di M3U e EPG
        const hasM3UChanges = this.config?.m3u !== newConfig.m3u;
        const hasEPGChanges = 
            this.config?.epg_enabled !== newConfig.epg_enabled ||
            this.config?.epg !== newConfig.epg;
        
        // Verifica altri cambiamenti di configurazione
        const hasOtherChanges = 
            this.config?.update_interval !== newConfig.update_interval ||
            this.config?.id_suffix !== newConfig.id_suffix ||
            this.config?.remapper_path !== newConfig.remapper_path;

        // Aggiorna la configurazione
        this.config = { ...this.config, ...newConfig };

        // --- MODIFICA BOMBA #1: Reloading Senza Interruzioni ---
        // Quando l'M3U cambia, ricarichiamo in background
        // ma NON cancelliamo la cache esistente. L'utente continua
        // a navigare i vecchi dati finché i nuovi non sono pronti.
        if (hasM3UChanges) {
            console.log('Playlist M3U modificata, ricarico in background...');
            // NON CANCELLIAMO LA CACHE
            // this.cache.stremioData = null; // <-- RIMOSSO
            // this.cache.m3uUrl = null; // <-- RIMOSSO
            
            if (this.config.m3u) {
                // Avviamo la ricostruzione, ma non è necessario attenderla
                // L'handler successivo userà la vecchia cache se questa è ancora in corso
                this.rebuildCache(this.config.m3u, this.config);
            }
        }
        // --- FINE MODIFICA BOMBA #1 ---

        if (hasEPGChanges) {
            console.log('Configurazione EPG modificata, aggiorno solo EPG...');
            // La logica EPG è gestita da EPGManager
        }

        if (hasOtherChanges) {
            console.log('Altre configurazioni modificate, riavvio polling...');
            this.startPolling(); // Riavvia il polling se l'intervallo cambia
        }
    }

    startPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }

        // Controlla ogni 60 secondi
        this.pollingInterval = setInterval(async () => {
            if (!this.cache?.stremioData) {
                return; // Niente da aggiornare se la cache è vuota
            }

            if (this.isStale(this.config)) {
                console.log('Controllo aggiornamento cache (Stale)...');
                try {
                    // La ricostruzione avverrà in background
                    await this.rebuildCache(this.cache.m3uUrl, this.config);
                } catch (error) {
                    // L'errore è già gestito in rebuildCache
                    console.error('Errore durante l\'aggiornamento automatico (Polling):', error.message);
                }
            }
        }, 60000); // 60 secondi
    }

    // --- MODIFICA BOMBA #2: Normalizzazione "Fuzzy" ---
    // Rimuove TUTTI i caratteri non alfanumerici (inclusi . e _)
    // Ora 'sky.sport.1' e 'SkySport1' diventeranno entrambi 'skysport1'
    normalizeId(id, removeSuffix = false) {
        let normalized = id?.toLowerCase().replace(/[^\w]/g, '').trim() || ''; // <-- MODIFICATO
        
        if (removeSuffix && this.config?.id_suffix) {
            // Rimuoviamo anche il suffisso normalizzato
            const suffix = this.config.id_suffix.toLowerCase().replace(/[^\w]/g, '').trim();
            if (normalized.endsWith(suffix)) {
                normalized = normalized.substring(0, normalized.length - suffix.length);
            }
        }
        
        return normalized;
    }
    // --- FINE MODIFICA BOMBA #2 ---


    addSuffix(id) {
        if (!id || !this.config?.id_suffix) return id;
        const suffix = `.${this.config.id_suffix}`;
        return id.endsWith(suffix) ? id : `${id}${suffix}`;
    }

    async rebuildCache(m3uUrl, config) {
        if (this.cache.updateInProgress) {
            console.log('⚠️  Ricostruzione cache già in corso, skip...');
            return;
        }

        try {
            this.cache.updateInProgress = true;
            console.log('\n=== Inizio Ricostruzione Cache (Background) ===');
            console.log('URL M3U:', m3uUrl);

            if (config) {
                this.config = {...this.config, ...config};
            }

            // 1. Carica e trasforma i nuovi dati
            const data = await this.transformer.loadAndTransform(m3uUrl, this.config);
        
            // 2. SOLO ORA, dopo che tutto è andato a buon fine,
            // sostituisci la vecchia cache con i nuovi dati.
            this.cache = {
                ...this.cache, // Preserva altri stati se necessario
                stremioData: data,
                lastUpdated: Date.now(),
                m3uUrl: m3uUrl,
                epgUrls: data.epgUrls
            };

            console.log(`✓ Canali in cache: ${data.channels.length}`);
            console.log(`✓ Generi trovati: ${data.genres.length}`);
            console.log('\n=== Cache Ricostruita (Background) ===\n');

            this.emit('cacheUpdated', this.cache);

        } catch (error) {
            // --- MODIFICA BOMBA #3: Cache Resiliente ---
            // Se la ricostruzione fallisce (es. M3U offline), non facciamo crashare l'app
            // e NON cancelliamo la vecchia cache. Ci riproveremo al prossimo polling.
            console.error('\n❌ ERRORE nella ricostruzione della cache:', error.message);
            console.log('ℹ️  Mantengo la cache precedente (stale) finché il problema non è risolto.');
            this.emit('cacheError', error);
            // NON lanciare 'throw error' per non bloccare il processo
            // --- FINE MODIFICA BOMBA #3 ---
        } finally {
            // In ogni caso, sblocchiamo l'aggiornamento
            this.cache.updateInProgress = false;
        }
    }

    getCachedData() {
        if (!this.cache || !this.cache.stremioData) return { channels: [], genres: [] };
        return {
            channels: this.cache.stremioData.channels,
            genres: this.cache.stremioData.genres
        };
    }

    getChannel(channelId) {
        if (!channelId || !this.cache?.stremioData?.channels) return null;
        
        // Usa la nuova normalizzazione "fuzzy"
        const normalizedSearchId = this.normalizeId(channelId);
        
        const channel = this.cache.stremioData.channels.find(ch => {
            // Compara ID canale, TVG ID e Nome Canale (tutti normalizzati)
            const normalizedChannelId = this.normalizeId(ch.id.replace('tv|', ''));
            const normalizedTvgId = this.normalizeId(ch.streamInfo?.tvg?.id);
            const normalizedName = this.normalizeId(ch.name); // Aggiunto controllo nome
            
            return normalizedChannelId === normalizedSearchId || 
                   normalizedTvgId === normalizedSearchId ||
                   normalizedName === normalizedSearchId; // Aggiunto controllo nome
        });

        // La logica di fallback non è più necessaria perché il find principale
        // ora controlla anche il nome.
        return channel;
    }

    getChannelsByGenre(genre) {
        if (!genre || !this.cache?.stremioData?.channels) return [];
        
        return this.cache.stremioData.channels.filter(channel => {
            if (!Array.isArray(channel.genre)) return false;
            // Normalizziamo anche i generi per sicurezza
            const hasGenre = channel.genre.some(g => g.toLowerCase() === genre.toLowerCase());
            return hasGenre;
        });
    }

    searchChannels(query) {
        if (!this.cache?.stremioData?.channels) return [];
        if (!query) return this.cache.stremioData.channels;
    
        const normalizedQuery = this.normalizeId(query); // Usa la normalizzazione fuzzy
    
        return this.cache.stremioData.channels.filter(channel => {
            const normalizedName = this.normalizeId(channel.name);
Attualmente, `package-lock.json` non è presente nei file. Vuoi che lo generi per te?
            return normalizedName.includes(normalizedQuery);
        });
    }

    isStale(config = {}) {
        if (!this.cache || !this.cache.lastUpdated || !this.cache.stremioData) return true;

        let updateIntervalMs = 12 * 60 * 60 * 1000; // Default 12 ore

        if (config.update_interval) {
            const timeMatch = config.update_interval.match(/^(\d{1,2}):(\d{2})$/);
            
            if (timeMatch) {
                const hours = parseInt(timeMatch[1], 10);
                const minutes = parseInt(timeMatch[2], 10);
                
                if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
                    updateIntervalMs = (hours * 60 * 60 + minutes * 60) * 1000;
                } else {
                    console.warn(`[Cache] Formato ora non valido (${config.update_interval}), uso valore predefinito (12h)`);
                }
            } else {
                console.warn(`[Cache] Formato ora non valido (${config.update_interval}), uso valore predefinito (12h)`);
            }
        }

        const timeSinceLastUpdate = Date.now() - this.cache.lastUpdated;
        const needsUpdate = timeSinceLastUpdate >= updateIntervalMs;
        
        if (needsUpdate) {
            console.log('[Cache] Cache obsoleta, necessario aggiornamento');
        }

        return needsUpdate;
    }

    setLastFilter(filterType, value) {
        this.lastFilter = { type: filterType, value };
    }

    getLastFilter() {
        return this.lastFilter;
    }

    clearLastFilter() {
        this.lastFilter = null;
    }

    getFilteredChannels() {
        if (!this.cache?.stremioData?.channels) return [];
        
        let channels = this.cache.stremioData.channels;
        
        if (this.lastFilter) {
            if (this.lastFilter.type === 'genre') {
                channels = this.getChannelsByGenre(this.lastFilter.value);
            } else if (this.lastFilter.type === 'search') {
                channels = this.searchChannels(this.lastFilter.value);
            }
        }

        return channels;
    }

    cleanup() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }
}

module.exports = (config) => new CacheManager(config);
