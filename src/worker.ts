//imports for a worker thread
importScripts("demuxer_mp4.js")
let renderer = null;
let startTime = null;
let pendingStatus = null;
let pendingFrame = null;
let frameCount = 0;
class Canvas2DRenderer {
    #canvas = null;
    #ctx = null;
    constructor(canvas){
        this.#canvas = canvas;
        this.#ctx = canvas.getContext("2d")
    }
    draw(frame){
        this.#canvas.width = frame.displayWidth
        this.#canvas.height = frame.displayHeight
        this.#ctx.drawImage(frame,0,0,frame.displayWidth, frame.displayHeight)
        frame.close();
    }
}

function setStatus(type,message){
    if(pendingStatus){
        pendingStatus[type] = message;
    } else {
        pendingStatus = {[type]: message}
        self.requestAnimationFrame(statusAnimationFrame)
    }
}

function statusAnimationFrame(){
    self.postMessage(pendingStatus);
    pendingStatus=null;
}

function renderFrame(frame){
    if(!pendingFrame){
        requestAnimationFrame(renderAnimationFrame);
    } else {
        pendingFrame.close();
    }
    pendingFrame = frame;
}

function renderAnimationFrame(){
    renderer.draw(pendingFrame);
    pendingFrame = null;
}

function start({dataUri, canvasOff}){

    renderer = new Canvas2DRenderer(canvasOff)
    const decoder = new VideoDecoder({
        output(frame) {
            if (startTime == null){
                startTime = performance.now();
            } else {
                const elapsed = (performance.now() - startTime) / 1000;
                const fps = ++frameCount / elapsed;
                setStatus("render", `${fps.toFixed(0)} fps`)
            }

            renderFrame(frame);
        },
        error(e){
            setStatus("decode", e);
        }
    })

    const demuxer = new MP4Demuxer(dataUri, {
        onConfig(config) {
        setStatus("decode", `${config.codec} @ ${config.codedWidth}x${config.codedHeight}`)
        decoder.configure(config);
        },
        onChunk(chunk) {
            decoder.decode(chunk);
        },
        onEndOfStream(){
            decoder.flush();
        },
        setStatus
    });

}

self.addEventListener("message", message => start(message.data), {once:true})