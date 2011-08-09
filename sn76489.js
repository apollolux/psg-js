function SN76489() {
	if (!this instanceof SN76489) return new SN76489();
/*
	void SN76489_Init(int which, int PSGClockValue, int SamplingRate);
	void SN76489_Reset(int which);
	void SN76489_Shutdown(void);
	void SN76489_Config(int which, int mute, int boost, int volume, int feedback);
	void SN76489_SetContext(int which, uint8 *data);
	void SN76489_GetContext(int which, uint8 *data);
	uint8 *SN76489_GetContextPtr(int which);
	int SN76489_GetContextSize(void);
	void SN76489_Write(int which, int data);
	void SN76489_GGStereoWrite(int which, int data);
	void SN76489_Update(int which, INT16 **buffer, int length);
*/
}

(function(){
var SN = {};
SN.feedback_patterns = {
	FB_BBCMICRO:0x8005,
	FB_SC3000:0x0006,
	FB_SEGAVDP:0x0009
};
SN.volume_modes = {
	VOL_TRUNC:0,
	VOL_FULL:1
};
SN.boost_modes = {
	BOOST_OFF:0,
	BOOST_ON:1
};
SN.mute_values = {
	MUTE_ALLOFF:0,
	MUTE_TONE1:1,
	MUTE_TONE2:2,
	MUTE_TONE3:4,
	MUTE_NOISE:8,
	MUTE_ALLON:15
};

var sn76489 = (function() {
	var o = {};
	o.Mute = 0;	// int
	o.BoostNoise = 0;	// int
	o.VolumeArray = 0;	// int
	o.Clock = 0.0;	// float
	o.dClock = 0.0;	// float
	o.PSGStereo = 0;	// int
	o.NumClocksForSample = 0;	// int
	o.WhiteNoiseFeedback = 0;	// int
	o.Registers = new Array(8);	// UINT16[8], Tone+vol*4
	o.LatchedRegister = 0;	// int
	o.NoiseShiftRegister = 0;	// UINT16
	o.NoiseFreq = 0;	// INT16, noise channel signal generator frequency
	o.ToneFreqVals = [0,0,0,0];	// INT16[4], frequency register values (counters)
	o.ToneFreqPos = [0,0,0,0];	// INT8[4], frequency channel flip-flops
	o.Channels = [0,0,0,0];	// INT16[4], value of each channel before stereo is applied
	o.IntermediatePos = [0,0,0,0];	// INT32[4], intermediate values used at boundaries between + and -
	return o;
})();

SN76489.prototype.ENUM = {
	feedback_patterns:SN.feedback_patterns,
	volume_modes:SN.volume_modes,
	boost_modes:SN.boost_modes,
	mute_values:SN.mute_values
};

SN.NoiseInitialState = 0x8000;
SN.PSG_CUTOFF = 0x6;
SN.PSGVolumeValues = [
	[892,892,892,760,623,497,404,323,257,198,159,123,96,75,60,0],
	[1516,1205,957,760,603,479,381,303,240,191,152,120,96,76,60,0]
];

SN76489.prototype.reset = function(p) {
	//console.log("SN::reset");
	p.PSGStereo = 0xff;
	var i = 4; while (--i>-1) {
		// initialize psg state
		p.Registers[i<<1] = 1;	// tone freq=1
		p.Registers[(i<<1)+1] = 0xf;	// vol=off
		//console.log("reg "+(1+(i<<1))+"="+p.Registers[(i<<1)+1]);
		p.NoiseFreq = 0x10;
		p.ToneFreqVals[i] = 0;	// set counters to 0
		p.ToneFreqPos[i] = 1;	// set flip-flops to 1
		p.IntermediatePos[i] = null;	// set intermediate positions to do-not-use value
	}
	p.LatchedRegister = 0;
	p.NoiseShiftRegister = SN.NoiseInitialState;	// init noise generator
	p.Clock = 0;	// zero the clock
};
SN76489.prototype.init = function(pcl, srate) {	// int clock value, int sampling rate
	//console.log("SN::init");
	sn76489.dClock = pcl/16.0/srate;
	this.reset(sn76489);
};
SN76489.prototype.shutdown = function(){};
SN76489.prototype.config = function(mute, boost, volume, feedback) {	// int, int, int, int
	//console.log("SN::config");
	sn76489.Mute = mute;
	sn76489.BoostNoise = boost;
	sn76489.VolumeArray = volume;
	sn76489.WhiteNoiseFeedback = feedback;
};
SN76489.prototype.setContext = function(){};
SN76489.prototype.getContext = function(){};
SN76489.prototype.getContextPtr = function(){return sn76489;};
SN76489.prototype.getContextSize = function(){return 1;};
SN76489.prototype.write = function(data) {	// int
	(function(p){
		if (data&0x80) {	// latch/data byte	%1 cc t dddd
			//console.log("PSG::write L "+data.toString(2)+" - "+((data>>5)&0x3)+" "+(data&0x10?'V':'T')+" "+(data&0xf).toString(2));
			p.LatchedRegister = (data>>4)&0x07;
			p.Registers[p.LatchedRegister] = (p.Registers[p.LatchedRegister]&0x3f0)|(data&0xf);	// zero low 4 bits and replace w/data
		}
		else {	// data byte	%0 - dddddd
			//console.log("PSG::write D "+data.toString(2));
			if (!(p.LatchedRegister%2)&&p.LatchedRegister<5)	// tone register
				p.Registers[p.LatchedRegister] = (p.Registers[p.LatchedRegister]&0x00f)|((data&0x3f)<<4);	// zero high 6 bits and replace w/data
			else	// other register
				p.Registers[p.LatchedRegister] = data&0x0f;	// replace w/data
		}
		switch (p.LatchedRegister) {
			case 0: case 2: case 4:	// tone channels
				if (p.Registers[p.LatchedRegister]===0) p.Registers[p.LatchedRegister] = 1;	// zero frequency changed to 1 to avoid div/0
				break;
			case 6:	// noise
				p.NoiseShiftRegister = SN.NoiseInitialState;	// reset shift register
				p.NoiseFreq = 0x10<<(p.Registers[6]&0x3);	// set noise signal generator frequency
				break;
		}
	})(sn76489);
};
SN76489.prototype.GGStereoWrite = function(data){sn76489.PSGStereo=data;};
SN76489.prototype.update = function(len) {
	var buf = [[],[]];
	(function(p){
		var i, j;
		j = -1; while (++j<len) {
			i = -1; while (++i<3) {
				p.Channels[i] = (p.Mute>>i&0x1)*SN.PSGVolumeValues[p.VolumeArray][p.Registers[(i<<1)+1]]*(
					p.IntermediatePos[i]!==null?
						p.IntermediatePos[i]/65536 :
						p.ToneFreqPos[i]
				);
				//console.log("ch "+i+" "+(p.Mute>>i&0x1?'+':'-')+" "+p.Channels[i]+" (reg "+(1+(i<<1))+"="+p.Registers[(i<<1)+1]+" v "+SN.PSGVolumeValues[p.VolumeArray][p.Registers[(i<<1)+1]]+" ipos "+p.IntermediatePos[i]+" fpos "+p.ToneFreqPos[i]+")");
			}
			//console.log("ch "+i+" "+(p.Mute>>i&0x1?'+':'-')+" "+p.Channels[i]+" (reg "+(1+(i<<1))+"="+p.Registers[(i<<1)+1]+" v "+SN.PSGVolumeValues[p.VolumeArray][p.Registers[(i<<1)+1]]+" nsr "+p.NoiseShiftRegister+")");
			p.Channels[3] = (p.Mute>>3&0x1)*SN.PSGVolumeValues[p.VolumeArray][p.Registers[7]]*(p.NoiseShiftRegister&0x1);
			if (p.BoostNoise) p.Channels[3] <<= 1;	// double noise volume if preferred
			buf[0][j] = 0;
			buf[1][j] = 0;
			i = -1; while (++i<4) {
				//console.log("buf["+j+"]["+i+"]="+p.Channels[i]);
				buf[0][j] += (p.PSGStereo>>(i+4)&0x1)*p.Channels[i];
				buf[1][j] += (p.PSGStereo>>i&0x1)*p.Channels[i];
			}
			if (isNaN(buf[0][j])) throw new Error("buffer "+j+" NaN!");
			p.Clock += p.dClock;
			p.NumClocksForSample = parseInt(p.Clock);
			p.Clock -= p.NumClocksForSample;
			// decrement tone channel counters
			i = -1; while (++i<3) p.ToneFreqVals[i] -= p.NumClocksForSample;
			// noise channel: match to tone2 or decrement its counter
			if (p.NoiseFreq===0x80) p.ToneFreqVals[3] = p.ToneFreqVals[2];
			else p.ToneFreqVals[3] -= p.NumClocksForSample;
			i = -1; while (++i<3) {	// tone channels
				if (p.ToneFreqVals[i]<=0) {
					if (p.Registers[i<<1]>SN.PSG_CUTOFF) {
						p.IntermediatePos[i] = parseInt((p.NumClocksForSample-p.Clock+(p.ToneFreqVals[i]<<1))*p.ToneFreqPos[i]/(p.NumClocksForSample+p.Clock)*65536);
						p.ToneFreqPos[i] = -p.ToneFreqPos[i];	// flip the flip-flop
					}
					else {
						p.ToneFreqPos[i] = 1;	// stuck value
						p.IntermediatePos[i] = null;
					}
					p.ToneFreqVals[i] += p.Registers[i<<1]*(p.NumClocksForSample/p.Registers[i<<1]+1);
				}
				else p.IntermediatePos[i] = null;
			}
			if (p.ToneFreqVals[3]<=0) {	// noise channel
				p.ToneFreqPos[3] = -p.ToneFreqPos[3];	// flip the flip-flop
				if (p.NoiseFreq!==0x80)	// if not matching tone2, decrement counter
					p.ToneFreqVals[3] += p.NoiseFreq*(p.NumClocksForSample/p.NoiseFreq+1);
				if (p.ToneFreqPos[3]===1) {	// only once per cycle
					var Feedback;	// int
					if (p.Registers[6]&0x4) {	// white noise
						switch (p.WhiteNoiseFeedback) {	// calculate parity of fed-back bits for feedback
							case 0x0006:	// SC-3000, %00000110
							case 0x0009:	// SMS, GG, MD, %00001001
								Feedback = (p.NoiseShiftRegister&p.WhiteNoiseFeedback)&&((p.NoiseShiftRegister&p.WhiteNoiseFeedback)^p.WhiteNoiseFeedback);
								break;
							case 0x8005:	// BBC Micro, falls thru
							default:
								Feedback = p.NoiseShiftRegister&p.WhiteNoiseFeedback;
								Feedback ^= Feedback>>8;
								Feedback ^= Feedback>>4;
								Feedback ^= Feedback>>2;
								Feedback ^= Feedback>>1;
								Feedback &= 1;
								break;
						}
					}
					else	// periodic noise
						Feedback = p.NoiseShiftRegister&1;
					p.NoiseShiftRegister = (p.NoiseShiftRegister>>1)|(Feedback<<15);
				}
			}
		}
	})(sn76489);
	return buf;
};

})();