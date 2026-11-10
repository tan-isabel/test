// MORPHSCAPE FINAL - built on the working Experiment 1E p5/ml5/BLE setup.
// Only the gesture behaviour, black presentation, and light trails differ.
// 36 physical units, central 16 active, PCA9685 0x40, ESP32-S3 GPIO8/9.

let handPose;
let video;
let hands = [];
let resetButton;
let trackingStatus;

const MS_COUNT = 16;
const MS_NEUTRAL = 90;
const MS_MIN = 5;
const MS_MAX = 180;
// Servo 1..16 -> physical PCA9685 channel (confirmed configuration map).
const msChannelForServo = [0,1,8,9,2,3,10,11,4,5,12,13,6,7,14,15];
const msMountainUp = [110,126,119,103,135,166,151,114,124,180,159,108,105,132,121,99];
const msMountainDown = [70,55,63,76,47,17,31,66,58,5,24,72,79,51,61,83];
const msCoordinates = Array.from({length:16}, (_,i) => ({
  x:(i%4) + (Math.floor(i/4)%2 ? 0.42 : 0),
  y:Math.floor(i/4)*0.92
}));
let msTargets = Array(MS_COUNT).fill(MS_NEUTRAL);
let msCurrent = Array(MS_COUNT).fill(MS_NEUTRAL);
let msTrails = [[],[]];
let msMode = 'READY';
let msTwoPrevious = null;
let msWideReference = null;
let msMountainDirection = 1;
let msGrip = null;
let msLastSend = 0;
let msLastHands = 0;

// Keep Experiment 1E's setup order: canvas, BLE button, RESET button,
// await HandPose, createCapture, hide video, detectStart.
async function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  bleSetup();
  resetButton = createButton('RESET');
  resetButton.id('resetButton');
  resetButton.mousePressed(msReset);
  trackingStatus = createDiv('Starting hand tracking...');
  trackingStatus.id('trackingStatus');
  try {
    handPose = await ml5.handPose();
    video = createCapture({video:{facingMode:'user'},audio:false});
    video.size(640,480);
    video.hide();
    handPose.detectStart(video, gotHands);
    trackingStatus.html('Hand tracking ready');
  } catch (error) {
    console.error('Hand tracking startup failed:',error);
    trackingStatus.html('Camera/hand tracking error: '+String(error.message || error));
  }
}

function gotHands(results) { hands = results; }
function msClamp(v,lo,hi) { return Math.max(lo,Math.min(hi,v)); }
function msKey(hand,i) { return hand.keypoints && hand.keypoints[i]; }
function msScreen(hand,i) {
  const p=msKey(hand,i);
  return p ? {x:width-map(p.x,0,640,0,width), y:map(p.y,0,480,0,height)} : null;
}
function msCenter(hand) {
  const points=[0,5,9,13,17].map(i=>msScreen(hand,i)).filter(Boolean);
  if(!points.length)return null;
  return {x:points.reduce((s,p)=>s+p.x,0)/points.length,
          y:points.reduce((s,p)=>s+p.y,0)/points.length};
}
function msFistScore(hand) {
  const wrist=msKey(hand,0);if(!wrist)return 0;
  let folded=0;
  for(const [tip,base] of [[8,5],[12,9],[16,13],[20,17]]) {
    const t=msKey(hand,tip),b=msKey(hand,base);
    if(!t||!b)continue;
    if(Math.hypot(t.x-wrist.x,t.y-wrist.y)<1.45*Math.hypot(b.x-wrist.x,b.y-wrist.y))folded++;
  }
  return folded/4;
}
function msReset() {
  msTargets.fill(90);msCurrent.fill(90);
  msMode='READY';msTwoPrevious=null;msWideReference=null;msGrip=null;
  msTrails=[[],[]];
  sendResetCommand();
}
function msUpdateGesture() {
  const detected=hands.map(h=>({hand:h,p:msCenter(h),fist:msFistScore(h)})).filter(h=>h.p);
  if(detected.length>=2) {
    msGrip=null;
    const a=detected[0].p,b=detected[1].p;
    const separation=Math.hypot(a.x-b.x,a.y-b.y)/Math.max(width,height);
    const midY=(a.y+b.y)/(2*height);
    if(!msTwoPrevious) {
      msTwoPrevious={separation,midY};
      msWideReference=separation;
    }
    const deltaSep=separation-msTwoPrevious.separation;
    const deltaY=midY-msTwoPrevious.midY;
    // Direction chosen from two-hand upward/downward convergence.
    if(deltaSep < -0.004 && Math.abs(deltaY)>0.002)
      msMountainDirection=deltaY<0 ? 1 : -1;
    msWideReference=Math.max(msWideReference,separation);
    const strength=msClamp((msWideReference-separation)/0.38,0,1);
    const shape=msMountainDirection===1?msMountainUp:msMountainDown;
    for(let i=0;i<16;i++)msTargets[i]=90+(shape[i]-90)*strength;
    msTwoPrevious={separation,midY};
    msMode=msMountainDirection===1?'MOUNTAIN':'VALLEY';
    return;
  }
  msTwoPrevious=null;msWideReference=null;
  if(detected.length===1 && detected[0].fist>=0.63) {
    const p=detected[0].p;
    if(!msGrip) {
      const px=msClamp(p.x/width,0,1)*3.42;
      const py=msClamp(p.y/height,0,1)*2.76;
      let best=0,nearest=Infinity;
      for(let i=0;i<16;i++){
        const d=Math.hypot(msCoordinates[i].x-px,msCoordinates[i].y-py);
        if(d<nearest){nearest=d;best=i;}
      }
      msGrip={index:best,startY:p.y,startAngle:msCurrent[best]};
    }
    const travel=msClamp((msGrip.startY-p.y)/(height*0.33),-1,1);
    const target=msClamp(msGrip.startAngle+travel*(travel>=0?90:85),5,180);
    const origin=msCoordinates[msGrip.index];
    for(let i=0;i<16;i++){
      const d=Math.hypot(msCoordinates[i].x-origin.x,msCoordinates[i].y-origin.y);
      const weight=Math.exp(-1.7*d*d);
      msTargets[i]=90+(target-90)*weight;
    }
    msMode='LOCAL PULL';
    return;
  }
  msGrip=null;
  msTargets.fill(90);
  msMode='RELEASE';
}
function msDrawTrails() {
  const now=millis();
  const detected=hands.map(h=>msCenter(h)).filter(Boolean);
  for(let i=0;i<2;i++){
    if(i<detected.length){
      const p=detected[i],old=msTrails[i].length?msTrails[i][msTrails[i].length-1]:null;
      const down=old && p.y-old.y>1.5;
      const cool=msMode==='VALLEY'||(msMode==='LOCAL PULL'&&msTargets.some(v=>v<85))||down;
      msTrails[i].push({x:p.x,y:p.y,time:now,cool:!!cool});
    }
    msTrails[i]=msTrails[i].filter(p=>now-p.time<900);
    const trail=msTrails[i];
    for(let j=1;j<trail.length;j++){
      const a=trail[j-1],b=trail[j],fade=msClamp(1-(now-b.time)/900,0,1);
      const palette=b.cool?[[69,107,255],[0,169,255],[56,228,245],[140,255,226]]:
                           [[255,55,95],[255,102,184],[255,153,77],[255,230,109]];
      const rgb=palette[Math.floor(j/5)%4];
      stroke(rgb[0],rgb[1],rgb[2],fade*40);strokeWeight(24);line(a.x,a.y,b.x,b.y);
      stroke(rgb[0],rgb[1],rgb[2],fade*110);strokeWeight(9);line(a.x,a.y,b.x,b.y);
      stroke(255,245,240,fade*220);strokeWeight(2);line(a.x,a.y,b.x,b.y);
    }
    if(i<detected.length){const p=detected[i];noStroke();fill(255,255,255,160);circle(p.x,p.y,9);}
  }
}
function msDrawGrid() {
  const diameter=Math.min(width/14,height/10,44);
  const gap=diameter*1.16;
  const left=width/2-2.7*gap;
  const top=height/2-2.5*gap;
  textAlign(CENTER,CENTER);
  for(let row=0;row<6;row++)for(let col=0;col<6;col++){
    const x=left+col*gap+(row%2?gap*0.4:0),y=top+row*gap;
    const active=row>=1&&row<=4&&col>=1&&col<=4;
    strokeWeight(1);stroke(active?color(85,205,210,170):color(130,130,130,90));
    fill(active?color(8,70,78,130):color(115,115,115,75));circle(x,y,diameter);
    if(active){
      const number=(row-1)*4+col;
      noStroke();fill(245);textSize(Math.max(11,diameter*0.33));
      text(number,x,y-diameter*0.15);
      textSize(Math.max(8,diameter*0.22));text(Math.round(msCurrent[number-1])+'°',x,y+diameter*0.19);
    }
  }
}
function draw() {
  background(0); // Camera runs but selfie video is NOT drawn.
  msUpdateGesture();
  const ease=msMode==='RELEASE'?0.13:0.28;
  for(let i=0;i<16;i++)msCurrent[i]+=(msTargets[i]-msCurrent[i])*ease;
  msDrawTrails();
  msDrawGrid();
  noStroke();fill(245);textAlign(CENTER,CENTER);textSize(15);
  text(msMode,width/2,45);
  const now=millis();
  if(bleConnected && now-msLastSend>=100){
    const channels=Array(16).fill(90);
    for(let i=0;i<16;i++)channels[msChannelForServo[i]]=Math.round(msCurrent[i]);
    sendAngles(channels);
    msLastSend=now;
  }
}
function windowResized(){resizeCanvas(windowWidth,windowHeight);}
