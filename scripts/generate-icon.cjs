const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const sizes = [16, 24, 32, 48, 64, 128, 256]
const root = path.resolve(__dirname, '..')
const source = path.join(root, 'resources', 'eva-launcher.svg')
const output = path.join(root, 'resources', 'icon.ico')

function createDib(size, bitmap) {
  const bitmapHeader = Buffer.alloc(40)
  const maskRowBytes = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * size)

  bitmapHeader.writeUInt32LE(40, 0)
  bitmapHeader.writeInt32LE(size, 4)
  bitmapHeader.writeInt32LE(size * 2, 8)
  bitmapHeader.writeUInt16LE(1, 12)
  bitmapHeader.writeUInt16LE(32, 14)
  bitmapHeader.writeUInt32LE(0, 16)
  bitmapHeader.writeUInt32LE(bitmap.length + mask.length, 20)

  // ICO bitmaps are bottom-up. Electron returns a BGRA bitmap from top to bottom.
  const pixels = Buffer.alloc(bitmap.length)
  const rowBytes = size * 4
  for (let row = 0; row < size; row++) {
    bitmap.copy(pixels, row * rowBytes, (size - row - 1) * rowBytes, (size - row) * rowBytes)
  }

  return Buffer.concat([bitmapHeader, pixels, mask])
}

function createIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = header.length + images.length * 16
  for (const image of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(image.size === 256 ? 0 : image.size, 0)
    entry.writeUInt8(image.size === 256 ? 0 : image.size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(image.dib.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += image.dib.length
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.dib)])
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    transparent: true,
    backgroundColor: '#00000000',
  })

  const svg = fs.readFileSync(source, 'utf8')
  const document = `<!doctype html><html><head><style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    svg { display: block; width: 100% !important; height: 100% !important; }
  </style></head><body>${svg}</body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
  const image = await window.webContents.capturePage()
  const images = sizes.map((size) => ({
    size,
    dib: createDib(size, image.resize({ width: size, height: size, quality: 'best' }).toBitmap()),
  }))

  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, createIco(images))
  window.destroy()
  app.quit()
})
