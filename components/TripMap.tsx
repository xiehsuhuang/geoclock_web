"use client";

import L from "leaflet";
import { useEffect } from "react";
import { Circle, MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";
import type { CurrentPosition, Destination } from "@/lib/types";

type TripMapProps = {
  destination: Destination;
  destinationLabel?: string;
  currentPosition?: CurrentPosition;
  currentLabel?: string;
  radiusMeters: number;
};

const destinationIcon = L.divIcon({
  className: "map-marker map-marker-destination",
  html: "<span></span>",
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

const currentIcon = L.divIcon({
  className: "map-marker map-marker-current",
  html: "<span></span>",
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});

export default function TripMap({ currentLabel = "目前位置", currentPosition, destination, destinationLabel = "目的地", radiusMeters }: TripMapProps) {
  if (typeof destination.lat !== "number" || typeof destination.lng !== "number") {
    return null;
  }

  const destinationPoint: [number, number] = [destination.lat, destination.lng];
  const currentPoint: [number, number] | undefined = currentPosition ? [currentPosition.lat, currentPosition.lng] : undefined;

  return (
    <MapContainer
      attributionControl
      center={currentPoint ?? destinationPoint}
      className="trip-map"
      scrollWheelZoom={false}
      touchZoom
      zoom={currentPoint ? 13 : 15}
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Marker icon={destinationIcon} position={destinationPoint} title={destinationLabel} />
      <Circle center={destinationPoint} pathOptions={{ color: "#f5f5f5", fillColor: "#f5f5f5", fillOpacity: 0.08 }} radius={radiusMeters} />
      {currentPoint ? (
        <>
          <Marker icon={currentIcon} position={currentPoint} title={currentLabel} />
          <Polyline pathOptions={{ color: "#d4d4d8", weight: 3, opacity: 0.76 }} positions={[currentPoint, destinationPoint]} />
        </>
      ) : null}
      <FitMap destinationPoint={destinationPoint} currentPoint={currentPoint} radiusMeters={radiusMeters} />
    </MapContainer>
  );
}

function FitMap({
  currentPoint,
  destinationPoint,
  radiusMeters
}: {
  currentPoint?: [number, number];
  destinationPoint: [number, number];
  radiusMeters: number;
}) {
  const map = useMap();
  useEffect(() => {
    const radiusDegrees = Math.max(radiusMeters / 111000, 0.004);

    if (currentPoint) {
      map.fitBounds([currentPoint, destinationPoint], { padding: [32, 32], maxZoom: 16 });
      return;
    }

    map.fitBounds(
      [
        [destinationPoint[0] - radiusDegrees, destinationPoint[1] - radiusDegrees],
        [destinationPoint[0] + radiusDegrees, destinationPoint[1] + radiusDegrees]
      ],
      { padding: [24, 24], maxZoom: 16 }
    );
  }, [currentPoint, destinationPoint, map, radiusMeters]);

  return null;
}
