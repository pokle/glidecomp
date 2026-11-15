/**
 * The prototype's real routes (/proto): the three open tasks of the bundled
 * Corryong Cup 2026 sample (web/samples/comps/corryong-cup-2026-open-t*), as
 * their .xctsk files hold them, and the waypoints those routes use. Real
 * coordinates, so the real map draws a real route.
 *
 * The waypoints carry no altitude on purpose: a turnpoint added from one has a
 * blank altitude, which is what "Fill altitudes from map" is for.
 */
import type { WaypointFileRecord, XCTask } from "@glidecomp/engine";

export const TASK_DATES: Record<string, string> = {
  "1": "2026-01-05",
  "2": "2026-01-06",
  "3": "2026-01-07",
};

export const COMP_TIME_ZONE = "Australia/Melbourne";

export const TASK_ROUTES: Record<string, XCTask> = {
  "1": {
    "earthModel": "WGS84",
    "goal": {
      "deadline": "08:00:00Z",
      "type": "CYLINDER"
    },
    "sss": {
      "direction": "EXIT",
      "timeGates": [
        "03:30:00Z",
        "03:45:00Z",
        "04:00:00Z",
        "04:15:00Z",
        "04:30:00Z",
        "04:45:00Z",
        "05:00:00Z",
        "05:15:00Z"
      ],
      "type": "RACE"
    },
    "taskType": "CLASSIC",
    "turnpoints": [
      {
        "radius": 3000,
        "type": "TAKEOFF",
        "waypoint": {
          "altSmoothed": 932,
          "description": "ELLIOT",
          "lat": -36.18583297729492,
          "lon": 147.97666931152344,
          "name": "ELLIOT"
        }
      },
      {
        "radius": 5000,
        "type": "SSS",
        "waypoint": {
          "altSmoothed": 932,
          "description": "ELLIOT",
          "lat": -36.18583297729492,
          "lon": 147.97666931152344,
          "name": "ELLIOT"
        }
      },
      {
        "radius": 1000,
        "waypoint": {
          "altSmoothed": 815,
          "description": "Half",
          "lat": -36.265472412109375,
          "lon": 147.87344360351562,
          "name": "HALFWY"
        }
      },
      {
        "radius": 3000,
        "waypoint": {
          "altSmoothed": 430,
          "description": "CUDGWE",
          "lat": -36.223182678222656,
          "lon": 147.7288055419922,
          "name": "CUDGWE"
        }
      },
      {
        "radius": 4000,
        "waypoint": {
          "altSmoothed": 263,
          "description": "TINTAL",
          "lat": -36.05194854736328,
          "lon": 147.9269256591797,
          "name": "TINTAL"
        }
      },
      {
        "radius": 3000,
        "waypoint": {
          "altSmoothed": 375,
          "description": "KANGCK",
          "lat": -36.26409912109375,
          "lon": 147.93846130371094,
          "name": "KANGCK"
        }
      },
      {
        "radius": 5000,
        "waypoint": {
          "altSmoothed": 324,
          "description": "CUDG",
          "lat": -36.192283630371094,
          "lon": 147.7702178955078,
          "name": "CUDG"
        }
      },
      {
        "radius": 400,
        "type": "ESS",
        "waypoint": {
          "altSmoothed": 276,
          "description": "North",
          "lat": -36.17775344848633,
          "lon": 147.92405700683594,
          "name": "NCORGL"
        }
      }
    ],
    "version": 1
  },
  "2": {
    "earthModel": "WGS84",
    "goal": {
      "deadline": "12:00:00Z",
      "type": "CYLINDER"
    },
    "sss": {
      "direction": "EXIT",
      "timeGates": [
        "03:30:00Z",
        "03:45:00Z",
        "04:00:00Z",
        "04:15:00Z",
        "04:30:00Z",
        "04:45:00Z",
        "05:30:00Z"
      ],
      "type": "RACE"
    },
    "taskType": "CLASSIC",
    "turnpoints": [
      {
        "radius": 400,
        "waypoint": {
          "lat": -36.185833,
          "lon": 147.976667,
          "altSmoothed": 0,
          "name": "ELLIOT",
          "description": "ELLIOT"
        },
        "type": "TAKEOFF"
      },
      {
        "radius": 3000,
        "waypoint": {
          "lat": -36.185833,
          "lon": 147.976667,
          "altSmoothed": 0,
          "name": "ELLIOT",
          "description": "ELLIOT"
        },
        "type": "SSS"
      },
      {
        "radius": 1000,
        "waypoint": {
          "lat": -36.265473,
          "lon": 147.873444,
          "altSmoothed": 0,
          "name": "HALFWY",
          "description": "Half"
        }
      },
      {
        "radius": 7000,
        "waypoint": {
          "lat": -36.263625,
          "lon": 148.020957,
          "altSmoothed": 0,
          "name": "BIGARA",
          "description": "BIGARA"
        }
      },
      {
        "radius": 2000,
        "waypoint": {
          "lat": -36.059067,
          "lon": 148.039833,
          "altSmoothed": 0,
          "name": "GRGGRG",
          "description": "GRGGRG"
        }
      },
      {
        "radius": 7000,
        "waypoint": {
          "lat": -36.242792,
          "lon": 147.883678,
          "altSmoothed": 0,
          "name": "DWYERS",
          "description": "DWYERS"
        }
      },
      {
        "radius": 1000,
        "waypoint": {
          "lat": -36.216217,
          "lon": 148.109783,
          "altSmoothed": 0,
          "name": "KHANCO",
          "description": "KHANCO"
        },
        "type": "ESS"
      },
      {
        "radius": 1000,
        "waypoint": {
          "lat": -36.216217,
          "lon": 148.109783,
          "altSmoothed": 0,
          "name": "KHANCO",
          "description": "KHANCO"
        }
      }
    ],
    "version": 1,
    "cylinderTolerance": 0.0005
  },
  "3": {
    "earthModel": "WGS84",
    "goal": {
      "deadline": "12:00:00Z",
      "type": "CYLINDER"
    },
    "sss": {
      "direction": "EXIT",
      "timeGates": [
        "03:00:00Z",
        "04:00:00Z"
      ],
      "type": "RACE"
    },
    "taskType": "CLASSIC",
    "turnpoints": [
      {
        "radius": 400,
        "waypoint": {
          "lat": -36.185833,
          "lon": 147.976667,
          "altSmoothed": 0,
          "name": "ELLIOT",
          "description": "ELLIOT"
        },
        "type": "TAKEOFF"
      },
      {
        "radius": 3000,
        "waypoint": {
          "lat": -36.185833,
          "lon": 147.976667,
          "altSmoothed": 0,
          "name": "ELLIOT",
          "description": "ELLIOT"
        },
        "type": "SSS"
      },
      {
        "radius": 1500,
        "waypoint": {
          "lat": -36.2641,
          "lon": 147.938467,
          "altSmoothed": 0,
          "name": "KANGCK",
          "description": "KANGCK"
        }
      },
      {
        "radius": 5000,
        "waypoint": {
          "lat": -36.263625,
          "lon": 148.020957,
          "altSmoothed": 0,
          "name": "BIGARA",
          "description": "BIGARA"
        }
      },
      {
        "radius": 2000,
        "waypoint": {
          "lat": -35.96785,
          "lon": 148.05805,
          "altSmoothed": 0,
          "name": "TOOMA",
          "description": "TOOMA"
        }
      },
      {
        "radius": 400,
        "waypoint": {
          "lat": -36.086533,
          "lon": 148.045583,
          "altSmoothed": 0,
          "name": "LIGHTH",
          "description": "LIGHTH"
        }
      },
      {
        "radius": 7000,
        "waypoint": {
          "lat": -36.242792,
          "lon": 147.883678,
          "altSmoothed": 0,
          "name": "DWYERS",
          "description": "DWYERS"
        }
      },
      {
        "radius": 1000,
        "waypoint": {
          "lat": -36.216217,
          "lon": 148.109783,
          "altSmoothed": 0,
          "name": "KHANCO",
          "description": "KHANCO"
        },
        "type": "ESS"
      },
      {
        "radius": 1000,
        "waypoint": {
          "lat": -36.216217,
          "lon": 148.109783,
          "altSmoothed": 0,
          "name": "KHANCO",
          "description": "KHANCO"
        }
      }
    ],
    "version": 1,
    "cylinderTolerance": 0.0005
  }
} as Record<string, XCTask>;

export const WAYPOINTS: WaypointFileRecord[] = [
  {
    "code": "ELLIOT",
    "name": "ELLIOT",
    "latitude": -36.18583297729492,
    "longitude": 147.97666931152344,
    "radius": 400
  },
  {
    "code": "HALFWY",
    "name": "Half",
    "latitude": -36.265472412109375,
    "longitude": 147.87344360351562,
    "radius": 400
  },
  {
    "code": "CUDGWE",
    "name": "CUDGWE",
    "latitude": -36.223182678222656,
    "longitude": 147.7288055419922,
    "radius": 400
  },
  {
    "code": "TINTAL",
    "name": "TINTAL",
    "latitude": -36.05194854736328,
    "longitude": 147.9269256591797,
    "radius": 400
  },
  {
    "code": "KANGCK",
    "name": "KANGCK",
    "latitude": -36.26409912109375,
    "longitude": 147.93846130371094,
    "radius": 400
  },
  {
    "code": "CUDG",
    "name": "CUDG",
    "latitude": -36.192283630371094,
    "longitude": 147.7702178955078,
    "radius": 400
  },
  {
    "code": "NCORGL",
    "name": "North",
    "latitude": -36.17775344848633,
    "longitude": 147.92405700683594,
    "radius": 400
  },
  {
    "code": "BIGARA",
    "name": "BIGARA",
    "latitude": -36.263625,
    "longitude": 148.020957,
    "radius": 400
  },
  {
    "code": "GRGGRG",
    "name": "GRGGRG",
    "latitude": -36.059067,
    "longitude": 148.039833,
    "radius": 400
  },
  {
    "code": "DWYERS",
    "name": "DWYERS",
    "latitude": -36.242792,
    "longitude": 147.883678,
    "radius": 400
  },
  {
    "code": "KHANCO",
    "name": "KHANCO",
    "latitude": -36.216217,
    "longitude": 148.109783,
    "radius": 400
  },
  {
    "code": "TOOMA",
    "name": "TOOMA",
    "latitude": -35.96785,
    "longitude": 148.05805,
    "radius": 400
  },
  {
    "code": "LIGHTH",
    "name": "LIGHTH",
    "latitude": -36.086533,
    "longitude": 148.045583,
    "radius": 400
  }
];
