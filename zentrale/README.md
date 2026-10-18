# 〄 MRPG Zentrale v4

Die Zentrale für alle Projekte, Apps und KI-Modelle. Sie läuft portabel aus einem Ordner oder im Docker-Container.

## Start

**Portabel (Linux, CachyOS, Windows)**
```sh
./start.sh          # Linux
start.bat           # Windows
```
Danach öffnet sich der Browser auf http://localhost:7777.

**Docker (CachyOS)**
```sh
docker compose up -d --build
```

## KI-Modelle: Login mit deinem Abo, ohne API-Keys
| Modell | Anmelden (portabel) | Anmelden (Docker) |
|---|---|---|
| Claude | `./start.sh login claude` | `docker exec -it mrpg-zentrale node server.js login claude` |
| Codex | `./start.sh login codex` | `docker exec -it mrpg-zentrale node server.js login codex` |
| Gemini | `./start.sh login gemini` | `docker exec -it mrpg-zentrale node server.js login gemini` |
| Ollama | kein Login, läuft lokal | – |

Die Logins werden in `data/auth/<modell>/` gespeichert und bleiben dadurch im Zentrale-Ordner.
Bei der portablen Version sucht die Zentrale die CLIs zuerst in `runtime/bin/` und danach im System-PATH.

## Ordner
```
server.js         Kern: Modul-Loader, KI-Hub, Event-Bus, Store
ui/               Dashboard und theme.css (MrPG.dev-Design-Tokens)
modules/<id>/     ein Modul = module.json + index.html
runtime/          portable Programme (node/, bin/)
data/             Logins, Speicher, Verlauf (nicht im Git)
```

## Eigenes Modul bauen
`modules/mein-modul/module.json`
```json
{ "name": "Mein Modul", "icon": "★", "order": 50, "description": "…" }
```
`modules/mein-modul/index.html`
```html
<link rel="stylesheet" href="/theme.css">
<script src="/zentrale-sdk.js"></script>
<script>
  zentrale.ki.ask({ provider: 'claude', prompt: 'Hallo', onChunk: (t, all) => console.log(all) });
  zentrale.store.set({ x: 1 });                 // eigener Speicher
  zentrale.events.emit('datei.offen', { pfad }); // an andere Module senden
  zentrale.events.on('datei.offen', p => …);     // empfangen
  zentrale.open('ki-chat');                      // anderes Modul öffnen
</script>
```
