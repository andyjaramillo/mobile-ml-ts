import { NotifyType } from "./Notification";
import { WARNINGS } from "./warnings";

const HYPERPARAMETERS = {
    T_disp_norm: 0.01, // normalized mean frame-to-frame centroid displacement (fraction of diag)
    T_drift_norm: 5.0, // normalized total drift from first (fraction of diag)
    T_area: 0.50, // max area change pct from first
    T_area_cv: 0.12, // area coefficient of variation
    distance_from_start: 500
  };
  
type Point = { x: number; y: number };

class SubjectNotAtStart {
    #last_centroid: Point | null = null;
    #pathLength = 0;
    #count = 0;
    #marker_centroid: Point | null = null;
    #original_area: number | null = null;
    #last_area: number | null = null;
    #prev_area: number | null = null;
    #maxAreaChangePct = 0;

    // running stats for area CV (std / mean)
    #areaCount = 0;
    #areaSum = 0;
    #areaSumSq = 0;

    // running stats for area slope over frame index x = 0, 1, 2, ...
    #sumX = 0;
    #sumY = 0;
    #sumXY = 0;
    #sumX2 = 0;

    trigger(offctx, detections, notif: NotifyType, marker_centroid: Point, current_frame_count: number) {
        this.#marker_centroid = marker_centroid;
        if (detections.length == 0) {
            notif.warning(`${WARNINGS.SUBJECT_AT_START_LINE_UNKNOWN}, Frame ${current_frame_count}`);
            return false
        } else if (detections.length > 1) {
            // finish for issue # 3
            notif.warning(`${WARNINGS.TOO_MANY_PEOPLE}, Frame ${current_frame_count}`);
            return false
        }
        const diag = Math.hypot(offctx.canvas.width, offctx.canvas.height) || 1;

        const detection = detections[0]
        const { originX, originY, width, height } = detection.boundingBox;
        const current_centroid = this.#get_centroid(detection)



        // offctx.strokeStyle = "red";
        // offctx.lineWidth = 2;
        // offctx.strokeRect(originX, originY, width, height);

    


        if (this.#last_centroid) {
            this.#pathLength += this.#frameDistance(current_centroid, this.#last_centroid);
           
            this.#count += 1;
            this.#last_centroid = current_centroid
     
        }
        this.#last_centroid = current_centroid
        //3 get bounding box area
        const area = width * height

        
        //4. check 2 frame check area
        this.#updateAreaStats(area);
        return this.check_logic_flow(detection, notif, current_frame_count)
            // const meanFrameDisplacement = this.mean_frame_to_frame_displacement() / diag;
            // const centroidStable = meanFrameDisplacement < HYPERPARAMETERS.T_disp;
            // const bboxScaleStable =
            //     this.#maxAreaChangePct < HYPERPARAMETERS.T_area &&
            //     this.area_coefficient_of_variation() < HYPERPARAMETERS.T_area_cv;

            // if (centroidStable && bboxScaleStable) {
            //     // subject stationary in setup window
            // }
        
    
    }

    #updateAreaStats(area: number) {
        if (this.#original_area === null) {
            this.#original_area = area;
        } else {
            const changePct = Math.abs(area - this.#original_area) / (this.#original_area || 1);
            this.#maxAreaChangePct = Math.max(this.#maxAreaChangePct, changePct);
        }

        const x = this.#areaCount;
        this.#areaSum += area;
        this.#areaSumSq += area * area;
        this.#sumX += x;
        this.#sumY += area;
        this.#sumXY += x * area;
        this.#sumX2 += x * x;
        this.#areaCount += 1;
        this.#prev_area = this.#last_area;
        this.#last_area = area;
    }

    #frameDistance(current_centroid, last_centroid){
        return Math.sqrt(Math.pow(current_centroid.x - last_centroid.x,2) + Math.pow(current_centroid.y - last_centroid.y,2))
    }
    centroid_displacement_from_start(current_centroid){
        return Math.sqrt(Math.pow(current_centroid.x - this.#marker_centroid.x,2) + Math.pow(current_centroid.y - this.#marker_centroid.y,2))
    }

    #get_centroid(detection){
        const { originX, originY, width, height } = detection.boundingBox;
        const current_centroid = {
            x: originX + width / 2,
            y: originY + height / 2,
        };
        return current_centroid
    }

    mean_frame_to_frame_displacement(){
        return this.#count === 0 ? 0 : this.#pathLength / this.#count;
    }

    centroid_path_length(){
        return this.#pathLength
    }

    max_area_change_pct() {
        return this.#maxAreaChangePct;
    }

    area_coefficient_of_variation() {
        if (this.#areaCount === 0) return 0;
        const mean = this.#areaSum / this.#areaCount;
        if (mean === 0) return 0;
        const variance = this.#areaSumSq / this.#areaCount - mean * mean;
        const std = Math.sqrt(Math.max(0, variance));
        return std / mean;
    }

    // least-squares slope over frame index; positive = area trending up
    area_monotonic_trend() {
        if (this.#areaCount < 2) return 0;
        const n = this.#areaCount;
        const num = n * this.#sumXY - this.#sumX * this.#sumY;
        const den = n * this.#sumX2 - this.#sumX * this.#sumX;
        return den === 0 ? 0 : num / den;
    }

    // frame-to-frame area change using only the previous value
    area_change_from_previous() {
        if (this.#last_area === null || this.#prev_area === null) return 0;
        return this.#last_area - this.#prev_area;
    }

    check_logic_flow(detection,notif, current_frame_count){
        // if not stationary at start. stationary = displacement && area
      
        if(this.mean_frame_to_frame_displacement()>HYPERPARAMETERS.T_drift_norm || this.max_area_change_pct() > HYPERPARAMETERS.T_area){
            notif.warning(`${WARNINGS.SUBJECT_MOVED_TOO_MUCH}, ${this.mean_frame_to_frame_displacement()},T_Drift_Norm: ${HYPERPARAMETERS.T_drift_norm}, ${this.max_area_change_pct()},T_Area: ${HYPERPARAMETERS.T_area}`)
            return false
        }
        // if stationary but far from the start. we check stationary first and return if false
        else if(this.centroid_displacement_from_start(this.#get_centroid(detection)) > HYPERPARAMETERS.distance_from_start){
            notif.warning(`${WARNINGS.SUBJECT_AT_START_LINE_UNKNOWN}, Frame ${current_frame_count}`)
            return false
         }
         return true
    }

    get_summary_of_data(){
        return {
            mean_flow_displacement: this.mean_frame_to_frame_displacement(),
            max_area_change_pct: this.max_area_change_pct(),
            centroid_displacement: this.centroid_displacement_from_start(this.#last_centroid)

        }
    }
}

export default SubjectNotAtStart;
