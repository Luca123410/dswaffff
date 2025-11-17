const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');
const cron = require('node-cron');
const sax = require('sax'); // NUOVO: Parser streaming (sostituisce xml2js)

// 'gunzip' non è più usato con gli stream, usiamo i pipe
// const gunzip = promisify(zlib.gunzip); 

class EPGManager {
    constructor() {
        this.epgData = null;
        this.programGuide = new Map();
        this.channelIcons = new Map();
        this.lastUpdate = null;
        this.isUpdating = false;
        // CHUNK_SIZE non è più necessario con lo streaming
        this.lastEpgUrl = null;
        this.cronJob = null;
        this.validateAndSetTimezone(); // Modificato
    }

    normalizeId(id) {
        return id?.toLowerCase().replace(/[^\w.]/g, '').trim() || '';
    }

    // --- MODIFICATO: Gestione Fuso Orario ---
    validateAndSetTimezone() {
        // Usa un nome IANA (es. "Europe/Rome") invece di un offset fisso
        // Questo gestisce automaticamente l'ora legale (es. +1:00 vs +2:00)
        this.timeZoneName = process.env.TIMEZONE_NAME || 'Europe/Rome';
        console.log(`Fuso orario EPG impostato su: ${this.timeZoneName}`);
    }

    // --- MODIFICATO: Gestione Fuso Orario ---
    formatDateIT(date) {
        if (!date) return '';
        // Applica il fuso orario IANA
        return date.toLocaleString('it-IT', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: this.timeZoneName 
        }).replace(/\./g, ':');
    }

    parseEPGDate(dateString) {
        if (!dateString) return null;
        try {
            const regex = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/;
            const match = dateString.match(regex);
            
            if (!match) return null;
            
            const [_, year, month, day, hour, minute, second, timezone] = match;
            const tzHours = timezone.substring(0, 3);
            const tzMinutes = timezone.substring(3);
            const isoString = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzHours}:${tzMinutes}`;
            
            const date = new Date(isoString);
            return isNaN(date.getTime()) ? null : date;
        } catch (error) {
            console.error('Errore nel parsing della data EPG:', error);
            return null;
        }
    }

    async initializeEPG(url) {
        if (this.lastEpgUrl === url && this.programGuide.size > 0) {
            console.log('EPG già inizializzato e valido, skip...');
            return;
        }

        console.log('\n=== Inizializzazione EPG ===');
        console.log('URL EPG:', url);
        this.lastEpgUrl = url;
        await this.startEPGUpdate(url);
        
        if (!this.cronJob) {
            console.log('Schedulazione aggiornamento EPG giornaliero alle 3:00');
            this.cronJob = cron.schedule('0 3 * * *', () => {
                console.log('Esecuzione aggiornamento EPG programmato');
                this.startEPGUpdate(this.lastEpgUrl);
            });
        }
        console.log('=== Inizializzazione EPG completata ===\n');
    }

    // --- MODIFICATO: Parsing in Streaming (Anti-Crash) ---
    async downloadAndProcessEPG(epgUrl) {
        console.log('\nDownload e Streaming EPG da:', epgUrl.trim());

        return new Promise(async (resolve, reject) => {
            try {
                // 1. Configura il parser SAX (legge l'XML pezzo per pezzo)
                const saxStream = sax.createStream(true); // true = strict mode
                let currentProgram = {};
                let currentChannel = {};
                let currentTag = '';
                let inProgramme = false;
                let inChannel = false;

                // 2. Definisci cosa fare quando il parser incontra i tag
                saxStream.on('opentag', (node) => {
                    currentTag = node.name;
                    if (currentTag === 'programme') {
                        inProgramme = true;
                        currentProgram = { 
                            channel: node.attributes.channel, 
                            start: node.attributes.start, 
                            stop: node.attributes.stop 
                        };
                    } else if (currentTag === 'channel') {
                        inChannel = true;
                        currentChannel = { id: node.attributes.id };
                    } else if (currentTag === 'icon' && inChannel && node.attributes.src) {
                        currentChannel.icon = node.attributes.src;
                    }
                });

                saxStream.on('text', (text) => {
                    if (inProgramme) {
                        if (currentTag === 'title') {
                            currentProgram.title = (currentProgram.title || '') + text;
                        } else if (currentTag === 'desc') {
                            currentProgram.description = (currentProgram.description || '') + text;
                        } else if (currentTag === 'category') {
                            currentProgram.category = (currentProgram.category || '') + text;
                        }
                    }
                });

                saxStream.on('closetag', (tagName) => {
                    if (tagName === 'programme') {
                        this.processStreamedProgram(currentProgram); // Processa il singolo programma
                        inProgramme = false;
                        currentProgram = {};
                    } else if (tagName === 'channel') {
                        this.processStreamedChannel(currentChannel); // Processa il singolo canale
                        inChannel = false;
                        currentChannel = {};
                    }
                    currentTag = ''; // Resetta il tag corrente
                });

                saxStream.on('error', (e) => {
                    console.error(`❌ Errore SAX: ${e.message}`);
                    // Non rifiutare la promise, potremmo aver processato parte del file
                });

                saxStream.on('end', () => {
                    console.log(`✓ Streaming EPG completato per ${epgUrl}`);
                    resolve();
                });

                // 3. Avvia il download come stream
                const response = await axios.get(epgUrl.trim(), {
                    responseType: 'stream', // FONDAMENTALE!
                    timeout: 100000,
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip, deflate, br' }
                });

                // 4. Collega (pipe) gli stream
                let stream = response.data;
                const encoding = response.headers['content-encoding'];
                
                if (encoding === 'gzip' || epgUrl.endsWith('.gz')) {
                    console.log('Rilevato Gzip, decomprimo in stream...');
                    stream = stream.pipe(zlib.createGunzip());
                } else if (encoding === 'deflate') {
                    console.log('Rilevato Deflate, decomprimo in stream...');
                    stream = stream.pipe(zlib.createInflate());
                }

                // Collega lo stream (decompresso o meno) al parser SAX
                stream.pipe(saxStream);

            } catch (error) {
                console.error(`❌ Errore EPG (Stream): ${error.message}`);
                reject(error);
            }
        });
    }

    // --- NUOVA FUNZIONE HELPER ---
    // Processa un singolo programma ricevuto dal parser SAX
    processStreamedProgram(program) {
        const normalizedChannelId = this.normalizeId(program.channel);
        if (!normalizedChannelId || !program.start || !program.stop) {
            return; // Dati incompleti
        }

        const start = this.parseEPGDate(program.start);
        const stop = this.parseEPGDate(program.stop);

        if (!start || !stop) return; // Data non valida

        if (!this.programGuide.has(normalizedChannelId)) {
            this.programGuide.set(normalizedChannelId, []);
        }

        this.programGuide.get(normalizedChannelId).push({
            start,
            stop,
            title: program.title || 'Nessun Titolo',
            description: program.description || '',
            category: program.category || ''
        });
    }
    
    // --- NUOVA FUNZIONE HELPER ---
    // Processa un singolo canale ricevuto dal parser SAX
    processStreamedChannel(channel) {
        const normalizedChannelId = this.normalizeId(channel.id);
        if (!normalizedChannelId || !channel.icon) {
            return; // Dati incompleti
        }

        if (!this.channelIcons.has(normalizedChannelId)) {
            this.channelIcons.set(normalizedChannelId, channel.icon);
        }
    }


    // La funzione processEPGInChunks non è più necessaria

    async readExternalFile(url) {
        // Questa funzione è già ottima, la manteniamo com'è
        if (Array.isArray(url)) {
            return url;
        }

        if (url.includes(',')) {
            return url.split(',').map(u => u.trim());
        }

        try {
            console.log('Tentativo lettura file:', url);
            
            if (url.endsWith('.gz')) {
                console.log('File gzipped EPG trovato');
                return [url];
            }
            
            const response = await axios.get(url.trim());
            const content = response.data;
            
            if (typeof content === 'string' && 
                (content.includes('<?xml') || content.includes('<tv'))) {
                console.log('File EPG trovato direttamente');
                return [url];
            }
            
            const urls = content.split('\n')
                .filter(line => line.trim() !== '' && line.startsWith('http'));
                
            if (urls.length > 0) {
                console.log('Lista URLs trovata:', urls);
                return urls;
            }
            
            console.log('Nessun URL trovato, uso URL originale');
            return [url];
            
        } catch (error) {
            console.error('Errore nella lettura del file:', error);
            return [url];
        }
    }

    async startEPGUpdate(url) {
        if (this.isUpdating) {
            console.log('⚠️  Aggiornamento EPG già in corso, skip...');
            return;
        }

        console.log('\n=== Inizio Aggiornamento EPG ===');
        const startTime = Date.now();

        try {
            this.isUpdating = true;
            console.log('Inizio lettura URLs EPG...');
            
            const epgUrls = await this.readExternalFile(url);
            console.log('URLs trovati:', epgUrls);

            this.programGuide.clear();
            this.channelIcons.clear();

            for (const epgUrl of epgUrls) {
                console.log('\nProcesso URL EPG:', epgUrl);
                await this.downloadAndProcessEPG(epgUrl); // Funzione modificata
            }

            // Dopo che tutti i file sono stati processati, ordina i programmi
            for (const [channelId, programs] of this.programGuide.entries()) {
                this.programGuide.set(channelId, programs.sort((a, b) => a.start - b.start));
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`\n✓ Aggiornamento EPG completato in ${duration} secondi`);
            console.log(`✓ Totale canali con dati EPG: ${this.programGuide.size}`);
            console.log(`✓ Totale canali con icone: ${this.channelIcons.size}`);
            console.log('=== Aggiornamento EPG Completato ===\n');

        } catch (error) {
            console.error('❌ Errore dettagliato durante l\'aggiornamento EPG:', error);
            console.error('Stack:', error.stack);
        } finally {
            this.isUpdating = false;
            this.lastUpdate = Date.now();
        }
    }

    getCurrentProgram(channelId) {
        if (!channelId) return null;
        const normalizedChannelId = this.normalizeId(channelId);
        const programs = this.programGuide.get(normalizedChannelId);
        
        if (!programs?.length) return null;

        const now = new Date();
        const currentProgram = programs.find(program => program.start <= now && program.stop >= now);
        
        if (currentProgram) {
            return {
                ...currentProgram,
                start: this.formatDateIT(currentProgram.start),
                stop: this.formatDateIT(currentProgram.stop)
            };
        }
        
        return null;
    }

    getUpcomingPrograms(channelId) {
        if (!channelId) return [];
        const normalizedChannelId = this.normalizeId(channelId);
        const programs = this.programGuide.get(normalizedChannelId);
        
        if (!programs?.length) return [];

        const now = new Date();
        
        return programs
            .filter(program => program.start >= now)
            .slice(0, 2) // Mostra solo i prossimi 2
            .map(program => ({
                ...program,
                start: this.formatDateIT(program.start),
                stop: this.formatDateIT(program.stop)
            }));
    }

    getChannelIcon(channelId) {
        return channelId ? this.channelIcons?.get(this.normalizeId(channelId)) : null;
    }

    needsUpdate() {
        if (!this.lastUpdate) return true;
        return (Date.now() - this.lastUpdate) >= (24 * 60 * 60 * 1000);
    }

    isEPGAvailable() {
        return this.programGuide.size > 0 && !this.isUpdating;
    }

    getStatus() {
        return {
            isUpdating: this.isUpdating,
            lastUpdate: this.lastUpdate ? this.formatDateIT(new Date(this.lastUpdate)) : 'Mai',
            channelsCount: this.programGuide.size,
            iconsCount: this.channelIcons.size,
            programsCount: Array.from(this.programGuide.values())
                                .reduce((acc, progs) => acc + progs.length, 0),
            timezone: this.timeZoneName // Modificato
        };
    }

    checkMissingEPG(m3uChannels) {
        const epgChannels = Array.from(this.programGuide.keys());
        const missingEPG = [];

        m3uChannels.forEach(ch => {
            const tvgId = ch.streamInfo?.tvg?.id;
            if (tvgId) {
                const normalizedTvgId = this.normalizeId(tvgId);
                // Modifica per un confronto più robusto
                if (!epgChannels.some(epgId => epgId === normalizedTvgId)) {
                    missingEPG.push(ch);
                }
            }
        });

        if (missingEPG.length > 0) {
            console.log('\n=== Canali M3U senza EPG ===');
            missingEPG.forEach(ch => {
                console.log(`${ch.streamInfo?.tvg?.id}=`);
            });
            console.log(`✓ Totale canali M3U senza EPG: ${missingEPG.length}`);
            console.log('=============================\n');
        }
    }
}

// Esporta una singola istanza (singleton)
module.exports = new EPGManager();
