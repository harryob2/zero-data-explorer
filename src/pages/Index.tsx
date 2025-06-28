import { useState, useEffect, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ArrowRight, Zap, Wifi, WifiOff } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { toast } from 'sonner';

// Type definitions for Web Serial API
declare global {
  interface Navigator {
    serial: Serial;
  }
}

interface Serial {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

interface SerialPortRequestOptions {
  filters?: SerialPortFilter[];
}

interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface CO2DataPoint {
  timestamp: string;
  co2_ppm: number;
  formattedTime: string;
}

interface LoggingSession {
  id: number;
  startTime: string;
  endTime: string;
  data: CO2DataPoint[];
}

const Index = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [sessions, setSessions] = useState<LoggingSession[]>([]);
  const [currentSessionIndex, setCurrentSessionIndex] = useState(0);
  const [flipperPort, setFlipperPort] = useState<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter | null>(null);

  // Request permission to access Flipper Zero
  const requestFlipperPort = async (): Promise<SerialPort | null> => {
    try {
      const port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x0483, usbProductId: 0x5740 }]
      });
      return port;
    } catch (err) {
      console.error('No Flipper Zero or permission denied:', err);
      return null;
    }
  };

  // Auto-detect previously granted Flipper ports
  const findGrantedFlippers = async (): Promise<SerialPort[]> => {
    const ports = await navigator.serial.getPorts();
    return ports.filter(port => {
      const info = port.getInfo();
      return info.usbVendorId === 0x0483 && info.usbProductId === 0x5740;
    });
  };

  // Open the serial port
  const openFlipperPort = async (port: SerialPort) => {
    await port.open({ baudRate: 230400 });
    console.log('Flipper Zero opened at 230400 baud');
    return {
      reader: port.readable!.getReader(),
      writer: port.writable!.getWriter()
    };
  };

  // Parse CSV data into sessions
  const parseCSVData = (csvContent: string): LoggingSession[] => {
    const lines = csvContent.split('\n').filter(line => line.trim());
    if (lines.length <= 1) return []; // No data or just header

    const dataPoints: CO2DataPoint[] = [];
    
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const [timestamp, co2_ppm] = lines[i].split(',');
      if (timestamp && co2_ppm) {
        const date = new Date(parseInt(timestamp) * 1000);
        dataPoints.push({
          timestamp,
          co2_ppm: parseInt(co2_ppm),
          formattedTime: date.toLocaleTimeString()
        });
      }
    }

    // Group into sessions (separated by more than 5 minutes)
    const sessions: LoggingSession[] = [];
    let currentSession: CO2DataPoint[] = [];
    
    for (let i = 0; i < dataPoints.length; i++) {
      const point = dataPoints[i];
      
      if (currentSession.length === 0) {
        currentSession.push(point);
      } else {
        const lastPoint = currentSession[currentSession.length - 1];
        const timeDiff = parseInt(point.timestamp) - parseInt(lastPoint.timestamp);
        
        if (timeDiff > 300) { // 5 minutes = 300 seconds
          // Start new session
          const startTime = new Date(parseInt(currentSession[0].timestamp) * 1000);
          const endTime = new Date(parseInt(lastPoint.timestamp) * 1000);
          
          sessions.push({
            id: sessions.length,
            startTime: startTime.toLocaleString(),
            endTime: endTime.toLocaleString(),
            data: [...currentSession]
          });
          
          currentSession = [point];
        } else {
          currentSession.push(point);
        }
      }
    }
    
    // Don't forget the last session
    if (currentSession.length > 0) {
      const startTime = new Date(parseInt(currentSession[0].timestamp) * 1000);
      const endTime = new Date(parseInt(currentSession[currentSession.length - 1].timestamp) * 1000);
      
      sessions.push({
        id: sessions.length,
        startTime: startTime.toLocaleString(),
        endTime: endTime.toLocaleString(),
        data: [...currentSession]
      });
    }
    
    return sessions;
  };

  // Read file from Flipper Zero with simplified response logging
  const readFlipperFile = async () => {
    if (!writerRef.current || !readerRef.current) return;

    try {
      // Send command to read the CO2 logger file
      const command = 'storage read /ext/apps_data/co2_logger/co2_log.csv\n';
      console.log('=== SENDING COMMAND ===');
      console.log('Command:', JSON.stringify(command));
      
      await writerRef.current.write(new TextEncoder().encode(command));
      
      console.log('=== READING RESPONSE ===');
      
      let fullResponse = '';
      let timeout = setTimeout(() => {
        console.log('=== TIMEOUT REACHED ===');
        console.log('Full response received:', JSON.stringify(fullResponse));
        toast.error('Timeout waiting for response');
      }, 10000); // 10 second timeout
      
      // Read for 10 seconds and log everything
      const startTime = Date.now();
      while (Date.now() - startTime < 10000) {
        try {
          const result = await Promise.race([
            readerRef.current.read(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Read timeout')), 1000))
          ]);
